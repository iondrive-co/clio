import { spawnPty, adoptPty } from './pty.js';
import { cwdOf, foregroundCommand } from './procinfo.js';
import { TitleReader, lastTitleIn } from './termtitle.js';
import { extensionToState, extensionTitle } from '../extensions/index.js';

// How much raw output we keep per session. This is what gets replayed on
// reattach and written to disk for the post-reboot fallback.
const SCROLLBACK_BYTES = 512 * 1024;

/*
 * How long to wait for a new shell to be ready for a line typed into it.
 *
 * A prompt is the shell saying it is listening, so the first byte out of the pty
 * is the signal — plus a moment for whatever profile is still running to finish
 * arriving. The ceiling is for the shell that prints nothing at all: a bare PS1,
 * or a profile that takes its time. Writing early would not lose the line, since
 * the terminal's own buffer holds it either way, but it would be read by
 * whatever the profile happened to be running at the time.
 */
const SHELL_SETTLE_MS = 250;
const SHELL_READY_MS = 4000;

let nextOrder = 0;

export class Session {
  constructor({ id, title = null, order = null, cwd = null, container = null }) {
    this.id = id;
    this.title = title;
    this.order = order ?? nextOrder++;
    this.cwd = cwd || process.env.HOME;
    this.command = null;
    /** Which window's tab strip this session belongs to. */
    this.container = container;

    /** The process that owns the terminal right now, or null at the prompt. */
    this.foreground = null;
    /**
     * What this tab is holding, if it is holding anything — a conversation, a
     * host — and which extension knows about it. See src/extensions. Owned by
     * the host there; the daemon only carries it about and writes it down.
     */
    this.ext = null;
    /** A line waiting for the shell to be ready for it; see typeWhenReady. */
    this.pending = null;

    /**
     * What the program in this tab last said it was doing — the terminal title
     * it announced, exactly as it announced it. Read out of the output on its
     * way past; see ./termtitle.js for why the daemon reads these at all.
     *
     * Not persisted. It describes a running process, and after a reboot the
     * process is gone; what comes back instead is read out of the scrollback,
     * which is persisted. See seedScrollback.
     */
    this.termTitle = null;
    this.titles = new TitleReader();
    /** A title nobody has been told about yet; see takeTitleChange. */
    this.titleMoved = false;

    this.pty = null;
    this.status = 'restorable'; // 'live' | 'exited' | 'restorable'
    this.exitCode = null;

    this.cols = 80;
    this.rows = 24;

    this.chunks = [];
    this.bytes = 0;
    this.dirty = false;
    /** Output has arrived since anyone last looked at this session. */
    this.unseenOutput = false;

    this.onData = null; // set by the manager to fan out to attached clients
    this.onExit = null;

    if (order !== null && order >= nextOrder) nextOrder = order + 1;
  }

  get shellPid() {
    return this.pty ? this.pty.pid : null;
  }

  /**
   * Boot a real shell for this session.
   *
   * `env` is what the launcher last told the daemon about the desktop it is
   * running on. A daemon inherits its environment from whatever started it, and
   * that can be a session with no display at all — a service, a script, an
   * agent's shell — in which case every shell it spawns is one where xdg-open,
   * and everything built on it, silently has nowhere to open anything.
   */
  spawn({ cwd = this.cwd, cols = this.cols, rows = this.rows, shell = null, env = {} } = {}) {
    const file = shell || process.env.SHELL || '/bin/bash';
    this.cols = cols;
    this.rows = rows;
    this.cwd = cwd;
    // A shell of its own: whatever the last program in this tab called it was
    // not about this one. The new shell announces its own soon enough.
    this.termTitle = null;
    this.titles = new TitleReader();

    this.take(
      spawnPty({
        file,
        cwd,
        cols,
        rows,
        env: {
          ...process.env,
          ...env,
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          CLIO_SESSION: this.id,
        },
      }),
    );

    return this;
  }

  /**
   * Pick up a pty that was already running under the previous daemon.
   *
   * The shell is mid-conversation with whatever is on the other end, so nothing
   * here announces itself: no seam in the scrollback, no redraw, no resize. As
   * far as the shell is concerned nothing happened, which is the point.
   */
  adopt({ fd, pid, cols = this.cols, rows = this.rows }) {
    this.cols = cols;
    this.rows = rows;
    this.take(adoptPty({ fd, pid }));
    return this;
  }

  /** Wire a pty of either kind up to this session. */
  take(handle) {
    this.pty = handle;
    this.status = 'live';
    this.exitCode = null;

    handle.onData((data) => {
      // Output means the shell has got as far as drawing something, which is
      // the only sign it gives that it is ready to be typed at.
      if (this.pending && !this.pending.settle) this.settlePending();
      this.noteTitle(data);
      this.append(data);
      if (this.onData) this.onData(data);
    });

    handle.onExit((exitCode) => {
      this.status = 'exited';
      this.exitCode = exitCode;
      this.pty = null;
      this.command = null;
      this.foreground = null;
      this.cancelPending();
      if (this.onExit) this.onExit(exitCode);
    });
  }

  /**
   * Type a line into a shell that is still starting up.
   *
   * Used to put an agent's tab back the way it was after the daemon died. It is
   * typed rather than exec'd on purpose: the shell is an ordinary login shell,
   * the command lands in its history, the terminal echoes it so the scrollback
   * shows what happened, and when the agent exits there is a normal prompt
   * underneath instead of a tab that has run out of shell.
   *
   * With `run` the newline goes too and it starts by itself; without, it waits
   * at the prompt for somebody to press Enter.
   */
  typeWhenReady(command, { run = true } = {}) {
    if (!this.pty || !command) return;
    this.cancelPending();

    // Carriage return, which is what a terminal sends for Enter; the line
    // discipline turns it into a newline on the way in.
    this.pending = { text: run ? `${command}\r` : command, settle: null, deadline: null };
    this.pending.deadline = setTimeout(() => this.flushPending(), SHELL_READY_MS);
    this.pending.deadline.unref?.();
  }

  settlePending() {
    this.pending.settle = setTimeout(() => this.flushPending(), SHELL_SETTLE_MS);
    this.pending.settle.unref?.();
  }

  flushPending() {
    const waiting = this.pending;
    if (!waiting) return;
    this.cancelPending();
    this.write(waiting.text);
  }

  cancelPending() {
    if (!this.pending) return;
    clearTimeout(this.pending.settle);
    clearTimeout(this.pending.deadline);
    this.pending = null;
  }

  /** Watch the output go past for a title the program set for itself. */
  noteTitle(data) {
    const announced = this.titles.read(data);
    if (announced === null || announced === this.termTitle) return;
    this.termTitle = announced;
    this.titleMoved = true;
  }

  /**
   * Has the title moved since this was last asked?
   *
   * Asked on the proc poll rather than pushed the moment it happens: a program
   * that rewrites its title on every keystroke — which is most of them — would
   * otherwise cost one broadcast to every window per keystroke, and two seconds
   * late is not late for a tab label.
   */
  takeTitleChange() {
    const moved = this.titleMoved;
    this.titleMoved = false;
    return moved;
  }

  append(data) {
    this.chunks.push(data);
    this.bytes += Buffer.byteLength(data);
    this.dirty = true;

    while (this.bytes > SCROLLBACK_BYTES && this.chunks.length > 1) {
      const dropped = this.chunks.shift();
      this.bytes -= Buffer.byteLength(dropped);
    }
  }

  scrollback() {
    return this.chunks.join('');
  }

  /** Seed the buffer from disk when reconstructing a session after a reboot. */
  seedScrollback(text) {
    this.chunks = text ? [text] : [];
    this.bytes = text ? Buffer.byteLength(text) : 0;
    // The buffer is a recording of everything the program wrote, the titles it
    // set included, so the last one it announced is in there to be found. That
    // is what keeps a tab's name across a reload and a restart, instead of it
    // falling back to `claude` until whatever is in it happens to say something
    // about itself again.
    if (text) this.termTitle = lastTitleIn(text) ?? this.termTitle;
  }

  write(data) {
    if (this.pty) this.pty.write(data);
  }

  resize(cols, rows) {
    if (!cols || !rows) return;
    this.cols = cols;
    this.rows = rows;
    if (this.pty) {
      try {
        this.pty.resize(cols, rows);
      } catch {
        /* pty raced with exit */
      }
    }
  }

  /** The pty master, which is what a reload hands to the next daemon. */
  get fd() {
    return this.pty ? this.pty.fd : null;
  }

  /**
   * Stop and start reading the pty.
   *
   * Both sides of a handover use this. Output that arrives after we stop
   * reading waits in the kernel's own buffer for whoever picks the descriptor
   * up next, instead of being read into a process that is about to exit — which
   * is how bytes go missing across a reload.
   */
  pause() {
    this.pty?.pause();
  }

  resume() {
    this.pty?.resume();
  }

  /**
   * Nudge the pty so full-screen programs repaint themselves.
   *
   * Replaying the scrollback buffer gets a shell prompt back verbatim, but an
   * app holding the alternate screen (vim, htop, less) drew its UI once and
   * expects the terminal to have kept it. Toggling the size delivers SIGWINCH,
   * and those apps redraw from scratch in response.
   */
  nudgeRedraw() {
    if (!this.pty) return;
    const { cols, rows } = this;
    if (cols <= 1) return;
    try {
      this.pty.resize(cols - 1, rows);
      setTimeout(() => {
        try {
          if (this.pty) this.pty.resize(cols, rows);
        } catch {
          /* ignore */
        }
      }, 20);
    } catch {
      /* ignore */
    }
  }

  /** Refresh cwd + running command from /proc. Cheap enough to poll. */
  refreshProcInfo() {
    if (!this.pty) {
      this.foreground = null;
      return false;
    }
    let changed = false;

    const cwd = cwdOf(this.pty.pid);
    if (cwd && cwd !== this.cwd) {
      this.cwd = cwd;
      changed = true;
    }

    const fg = foregroundCommand(this.pty.pid);
    this.foreground = fg;
    const command = fg ? fg.argv.join(' ') : null;
    if (command !== this.command) {
      this.command = command;
      changed = true;
    }

    return changed;
  }

  /** What the UI needs to render a tab. */
  toJSON() {
    return {
      id: this.id,
      container: this.container,
      title: this.title,
      // What the program in here says it is doing, which for an agent is the job
      // it is on. The window has a live version of this for the tab it is
      // showing — xterm.js parses the same sequences — but only for that one, so
      // this is what every other tab in the row is named after.
      termTitle: this.termTitle,
      order: this.order,
      cwd: this.cwd,
      command: this.command,
      status: this.status,
      exitCode: this.exitCode,
      unseenOutput: this.unseenOutput,
      pid: this.shellPid,
      cols: this.cols,
      rows: this.rows,
      // What the tab is holding, and what its extension would like it called —
      // an ssh tab wants to be named after its host rather than after `ssh`.
      ext: this.ext ? { kind: this.ext.kind, title: extensionTitle(this.ext) } : null,
    };
  }

  /** What gets persisted so the session can be rebuilt after a reboot. */
  toState() {
    return {
      id: this.id,
      container: this.container,
      title: this.title,
      order: this.order,
      cwd: this.cwd,
      command: this.command,
      cols: this.cols,
      rows: this.rows,
      // What was in this tab, rather than what it was doing: the only thing
      // clio will start again by itself when the shells have to be rebuilt.
      ext: extensionToState(this.ext),
    };
  }
}
