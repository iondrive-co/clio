import { spawnPty, adoptPty } from './pty.js';
import { cwdOf, foregroundCommand } from './procinfo.js';
import { Screen } from './screen.js';
import { TitleReader, lastTitleIn } from './termtitle.js';
import { extensionToState, extensionTitle } from '../extensions/index.js';

// How much raw output we keep per session. This is what gets replayed on
// reattach and written to disk for the post-reboot fallback.
const SCROLLBACK_BYTES = 512 * 1024;

/*
 * How long to wait for a new shell to be ready for a line typed into it.
 *
 * Two questions, and for a long time this asked only the easy one. Output means
 * the shell has drawn something, and a quarter of a second of quiet after it
 * means whatever was being drawn has stopped — so `SHELL_SETTLE_MS` is measured
 * from the *last* byte, not the first, because a login profile arrives in
 * pieces and the first of them is not the prompt.
 *
 * The hard question is whether anything still owns the terminal. On 15 August a
 * restore rebuilt 24 tabs at once, every one of them ran a profile with
 * `keychain` in it, and the resume commands were typed 250ms after the first
 * thing keychain printed — into a shell that was still in its .bashrc. Nothing
 * was lost that day: keychain had already given up, and the line waited in the
 * kernel's buffer for bash to read. But the thing it was typed at was one that
 * asks for a passphrase, and a resume command typed into a passphrase prompt is
 * an ssh key's passphrase attempt made of somebody's session id. So the shell is
 * asked directly, through tpgid, whether it is at its own prompt; see
 * ./procinfo.js.
 *
 * The ceiling is long because the thing it is waiting through can be a person
 * answering a dialog. When it runs out and the shell is *still* busy, the line
 * is not typed at all — it is named in the tab instead, which is the same
 * bargain the seam makes for everything clio will not run by itself.
 */
const SHELL_SETTLE_MS = 250;
const SHELL_READY_MS = 30000;

/*
 * How much of what somebody typed at a tab with no shell in it is kept. See
 * write — a line or two, which is all anybody gets in before the shell arrives,
 * and a bound so that a tab whose shell never comes cannot grow one.
 */
const UNTYPED_BYTES = 4096;

/*
 * How much of the end of the output is read to find the line the cursor is on.
 * A question that does not fit in this is not one anybody could read either.
 */
const TAIL_BYTES = 2048;

/*
 * Escape sequences, taken out only as far as is needed to see the text: a title
 * (OSC), a colour or a cursor move (CSI), and the two-byte odds and ends. What
 * is left of the last line is roughly what somebody looking at the tab reads.
 */
const OSC = /\x1b][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const SHORT_ESCAPE = /\x1b[()#][0-9A-Za-z]|\x1b[=>78]/g;

/*
 * How long a program has to answer clio before the answer stops being clio's.
 *
 * A repaint starts as soon as the program reads the byte that asked for it, so
 * this only has to cover the first chunk of the answer — the rest arrives
 * behind it, and by then the tab has already been counted one way or the
 * other. Half a second is generous for that, and short enough that a command
 * somebody started in this tab and left running still reads as activity.
 */
const REDRAW_MS = 500;

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
    /** Somebody waiting for this shell to reach its own prompt; see whenReady. */
    this.pending = null;
    /** Typed at this tab before it had a shell to type into; see write. */
    this.typed = '';

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
    /**
     * When the title last became something else.
     *
     * A title that is being rewritten twice a second is a program working, and
     * one that has sat unchanged is a program that has stopped — which for an
     * agent is the difference between a spinner and a question waiting for an
     * answer. Only an extension knows how to read that of its own program; this
     * is the clock it reads it against. See src/extensions, observeAttention.
     */
    this.titleAt = 0;

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
    /**
     * What is on this tab's screen, and what was on it when somebody last
     * looked.
     *
     * The pair is what tells a tab with something new in it from a tab that has
     * been repainted: an agent checking for a new version writes the answer
     * into its footer and then wipes it again, which is two screensful of
     * output and no change at all. See ./screen.js, and the decision itself in
     * ./index.js, which is the side that knows who is looking at what.
     */
    this.screen = new Screen({ cols: this.cols, rows: this.rows });
    this.seenScreen = null;
    /**
     * What this tab is holding has stopped and is waiting for the user.
     *
     * Set on the edge, when something that was working stops, and only for a
     * tab nobody is looking at; cleared when it starts again or when somebody
     * looks. Not persisted, and deliberately: a tab that comes back from disk
     * is holding something that stopped before this daemon existed, and a row
     * of tabs all announcing that at once is not news. See ./index.js, where
     * the arming and the clearing both live.
     */
    this.waiting = false;
    /**
     * When clio last asked the program in here to draw itself again.
     *
     * A focus report and a SIGWINCH are clio talking, not the user: the window
     * lost the keyboard, the tab beside this one was clicked, the socket came
     * back. A full-screen program answers by painting its screen over again,
     * and that answer is not news — nothing happened in this tab, and a tab
     * that goes red for it is telling the row something untrue. Noted here so
     * that the output which follows can be recognised for what it is; see
     * unseen activity in ./index.js.
     */
    this.redrawAskedAt = 0;

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
    // not about this one. The new shell announces its own soon enough, and
    // whatever was waiting for somebody in here is not what is in here now.
    this.termTitle = null;
    this.titleAt = 0;
    this.titles = new TitleReader();
    this.waiting = false;
    // A shell of its own on a screen of its own: blank, and blank is something
    // this can be sure of.
    this.screen = new Screen({ cols, rows });
    this.seenScreen = null;

    this.take(
      spawnPty({
        file,
        cwd,
        cols,
        rows,
        env: {
          /*
           * Where OpenSSH asks for a passphrase.
           *
           * Its rule is that the question goes to a graphical prompt whenever
           * DISPLAY is set and stdin is not a terminal — and inside a perfectly
           * good terminal, plenty of things meet that description: keychain in
           * a profile, ssh-add down a pipe, ssh's own ProxyCommand. One of them
           * is a dialog nobody asked for. Forty-five of them is what a desktop
           * gets on the morning after a crash, because every tab's profile runs
           * in the same second and only one X client can hold the keyboard: a
           * couple win the grab and ask for a passphrase, and the rest come up
           * as “Could not grab input. A malicious client may be eavesdropping
           * on your session.” — one modal dialog per tab, every one of them
           * waiting to be clicked before the desktop can be used at all. That
           * was 21 August, 45 tabs, and it is the same restore the note above
           * SHELL_SETTLE_MS is about: keychain, in every profile, at once.
           *
           * A shell clio starts always has a terminal and somebody looking at
           * it, so the terminal is where the question belongs. First in the
           * object rather than last, because somebody who has set this for
           * themselves has decided something about their own desktop and that
           * decision still wins.
           */
          SSH_ASKPASS_REQUIRE: 'never',
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
    this.replayScreen(cols, rows);
    this.take(adoptPty({ fd, pid }));
    return this;
  }

  /**
   * The screen of a pty this process did not start, worked out from the
   * recording of it.
   *
   * Everything the program in here ever wrote is in the buffer — the daemon
   * standing down flushed it, this one read it back (see seedScrollback) — and
   * a screen is what you get by playing a recording into a terminal. That is
   * not an analogy: it is exactly what happens on the other side, because a
   * window attaching to a tab is handed this same recording and writes it into
   * a brand new xterm. So this reconstruction and what somebody sees when they
   * click the tab are the same screen, from the same bytes.
   *
   * A tab with nothing recorded is the one case left: whatever is on that
   * screen happened somewhere this cannot see, and Screen is told to say so
   * rather than to claim a blank screen it has not earned.
   *
   * Costs a parse of the buffer, which is half a megabyte at the very most and
   * measured in tens of milliseconds. A reload pays it once per tab, and what
   * it buys is a row of agents that does not go red at the first thing they
   * repaint after it.
   */
  replayScreen(cols = this.cols, rows = this.rows) {
    const recording = this.scrollback();
    this.screen = new Screen({ cols, rows, known: !!recording });
    if (recording) this.screen.write(recording);
    this.seenScreen = null;
    /*
     * And if this tab was not red when it was handed over, that screen has been
     * seen — because that is what not being red means. Saying so here is what
     * makes the reconstruction worth doing: without it every tab spends its
     * first burst after a reload back on the old coarse answer, and a desktop
     * where reloading is how new code arrives would go on flashing at somebody
     * every half hour anyway.
     */
    if (!this.unseenOutput) this.markSeen();
  }

  /** Wire a pty of either kind up to this session. */
  take(handle) {
    this.pty = handle;
    this.status = 'live';
    this.exitCode = null;

    // Whatever was typed at this tab while it was waiting for a shell, before
    // anything the daemon has to say to it. It goes into the pty's buffer and
    // is read at the prompt, which is what would have happened to it had the
    // shell been there and busy — the same bargain, not a new one.
    if (this.typed) {
      const waiting = this.typed;
      this.typed = '';
      handle.write(waiting);
    }

    handle.onData((data) => {
      // Still drawing, so still not finished. The wait is measured from here,
      // which means from the last thing the shell said rather than the first.
      if (this.pending) this.settlePending();
      this.noteTitle(data);
      this.screen.write(data);
      this.append(data);
      if (this.onData) this.onData(data);
    });

    handle.onExit((exitCode) => {
      this.status = 'exited';
      this.exitCode = exitCode;
      this.pty = null;
      this.command = null;
      this.foreground = null;
      this.cancelPending(false);
      if (this.onExit) this.onExit(exitCode);
    });
  }

  /**
   * Call back when this shell has finished starting up and is at its own
   * prompt — `done(true)` — or when `cap` runs out with it still busy, which is
   * `done(false)` and means somebody else has the terminal.
   *
   * Only one of these at a time per session; a second replaces the first, which
   * is told it lost. Everything that has to wait for a shell goes through here:
   * typing into it, and holding the next tab's restore back until this one has
   * got through its profile. See SHELL_SETTLE_MS.
   *
   * `idle` is what "ready" means. On, it is the shell's own prompt, which is
   * what you need before typing. Off, it is only that the output has stopped —
   * which is as far as a thing that has just been started gets on its own, and
   * all the answer there is when the question is "has that ssh finished doing
   * whatever it was going to do".
   */
  whenReady(done, { cap = SHELL_READY_MS, idle = true } = {}) {
    if (!this.pty) {
      done(false);
      return;
    }
    this.cancelPending(false);
    this.pending = { done, idle, settle: null, deadline: null };
    this.pending.deadline = setTimeout(() => this.cancelPending(false), cap);
    this.pending.deadline.unref?.();
    // A shell that prints nothing at all — a bare PS1 — still has to be waited
    // for. Start the clock now rather than on output that may never come.
    this.settlePending();
  }

  settlePending() {
    clearTimeout(this.pending.settle);
    this.pending.settle = setTimeout(() => {
      // Quiet, but is it *our* quiet? Something in the foreground here is the
      // profile still running, and the one that matters is the one that is
      // about to ask for a passphrase. Wait it out — the cap is the backstop.
      if (this.pending.idle && this.pty && foregroundCommand(this.pty.pid)) {
        this.settlePending();
        return;
      }
      this.cancelPending(true);
    }, SHELL_SETTLE_MS);
    this.pending.settle.unref?.();
  }

  /**
   * Stop waiting, and tell whoever was waiting how it ended. Exactly once:
   * a caller that is never told is a restore that stops halfway through.
   */
  cancelPending(ready) {
    const waiting = this.pending;
    if (!waiting) return null;
    clearTimeout(waiting.settle);
    clearTimeout(waiting.deadline);
    this.pending = null;
    waiting.done(ready);
    return waiting;
  }

  /**
   * Type a line into a shell that is still starting up.
   *
   * Used to put a tab back the way it was after the daemon died. It is typed
   * rather than exec'd on purpose: the shell is an ordinary login shell, the
   * command lands in its history, the terminal echoes it so the scrollback shows
   * what happened, and when the command exits there is a normal prompt
   * underneath instead of a tab that has run out of shell.
   *
   * With `run` the newline goes too and it starts by itself; without, it waits
   * at the prompt for somebody to press Enter.
   *
   * If the shell never comes free the line is *not* typed. Writing it anyway is
   * the tempting thing and is the bug this exists to prevent: whatever is
   * holding a terminal that long is holding it because it is waiting to be told
   * something, and it must not be told this. It is named in the tab instead.
   *
   * `onSettled` is told which of the two happened; the restore queue waits on it
   * before starting the next tab. See SessionManager.queueResume.
   */
  typeWhenReady(command, { run = true, onSettled = null } = {}) {
    if (!command) {
      onSettled?.(false);
      return;
    }
    // Carriage return, which is what a terminal sends for Enter; the line
    // discipline turns it into a newline on the way in.
    const text = run ? `${command}\r` : command;

    this.whenReady((ready) => {
      if (ready) {
        this.write(text);
      } else if (this.pty) {
        this.append(
          `\x1b[38;5;180m     something else is holding this terminal, so this was left for you:  ${command}\x1b[0m\r\n`,
        );
      }
      onSettled?.(ready);
    });
  }

  /** Watch the output go past for a title the program set for itself. */
  noteTitle(data) {
    const announced = this.titles.read(data);
    if (announced === null || announced === this.termTitle) return;
    this.termTitle = announced;
    this.titleAt = Date.now();
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

  /**
   * This screen has been seen. Whatever is on it now is what somebody is
   * looking at, so it is the thing the next lot of output has to differ from.
   */
  markSeen() {
    this.seenScreen = this.screen.digest();
  }

  /**
   * Is there something on this screen that nobody has seen?
   *
   * `null` — not a boolean — when the question cannot be answered: a screen that
   * met bytes it did not understand, or one inherited from another daemon, or
   * one nobody has looked at yet. The caller has an older and coarser answer for
   * that case (see drawsSomething in ./output.js) and this must not be mistaken
   * for it, in either direction: saying "nothing happened" about a screen this
   * cannot read is how a tab with a question in it sits there quietly.
   */
  screenIsNew() {
    if (!this.screen.sure || this.seenScreen === null) return null;
    return this.screen.digest() !== this.seenScreen;
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

  /** What is on the line the cursor is on, with the escapes taken out. */
  cursorLine() {
    let tail = '';
    for (let i = this.chunks.length - 1; i >= 0 && tail.length < TAIL_BYTES; i--) {
      tail = this.chunks[i] + tail;
    }
    const text = tail.slice(-TAIL_BYTES).replace(OSC, '').replace(CSI, '').replace(SHORT_ESCAPE, '');
    const line = text.slice(text.lastIndexOf('\n') + 1);
    // A carriage return puts the cursor back at the start of the line, so what
    // is on the line is whatever was written after the last one.
    const restart = line.lastIndexOf('\r');
    return (restart === -1 ? line : line.slice(restart + 1)).trimEnd();
  }

  /**
   * Is this tab stopped at a question that only a person can answer?
   *
   * The shape of one rather than the words: something has the terminal, and the
   * cursor is left at the end of a line ending in a colon or a question mark
   * with no newline after it. `Verification code:`, `Enter passphrase for key
   * '/home/miles/.ssh/id_rsa':`, `safe@host's password:`, `Are you sure you
   * want to continue connecting (yes/no/[fingerprint])?` — all of them, without
   * clio holding a list of other people's wordings, or having to know whether
   * it is ssh, sudo, a bastion's 2FA or a script on the far end doing the
   * asking. A program that has finished a line has ended it; one that is
   * waiting to be answered leaves the cursor sitting after the colon.
   *
   * A shell's own prompt is not a question — `$ `, `%`, `❯` — and a shell at
   * its own prompt has nothing in the foreground anyway, which is the cheaper
   * half of the test and is why it is asked first.
   *
   * What it is for is the restore queue, which must not dial a second host
   * while the first is still waiting for somebody to read a code off their
   * phone. See SessionManager.nextResume.
   */
  atUnansweredQuestion() {
    if (!this.pty) return false;
    if (!foregroundCommand(this.pty.pid)) return false;
    const line = this.cursorLine();
    return line.length > 0 && /[:?]$/.test(line);
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

  /**
   * Type into this tab.
   *
   * A tab without a shell keeps what is typed at it rather than dropping it. It
   * only happens for a moment and only during a restore, where the tabs behind
   * the first one wait for its profile before they get shells of their own (see
   * SessionManager.restoreFromDisk) — but a terminal that silently eats what you
   * typed while it was busy is the thing clio exists not to be, and a moment is
   * exactly long enough to catch somebody who came back to a rebuilt window and
   * started typing into the tab they had left focused.
   *
   * Held to a couple of lines' worth: this is somebody typing, and a buffer
   * growing without a bound is a buffer waiting for the tab whose shell never
   * arrives.
   */
  write(data) {
    if (this.pty) {
      this.pty.write(data);
      return;
    }
    if (this.status === 'exited') return;
    this.typed = (this.typed + data).slice(-UNTYPED_BYTES);
  }

  resize(cols, rows) {
    if (!cols || !rows) return;
    this.cols = cols;
    this.rows = rows;
    this.screen.resize(cols, rows);
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
      this.redrawAskedAt = Date.now();
      this.pty.resize(cols - 1, rows);
      setTimeout(() => {
        try {
          if (!this.pty) return;
          this.redrawAskedAt = Date.now();
          this.pty.resize(cols, rows);
        } catch {
          /* ignore */
        }
      }, 20);
    } catch {
      /* ignore */
    }
  }

  /** Is the output arriving now the answer to something clio asked for? */
  redrawingForClio() {
    return Date.now() - this.redrawAskedAt < REDRAW_MS;
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
      // Whatever is in here has stopped and is waiting to be answered. The row
      // flashes the tab; see .tab.waiting in src/ui/style.css.
      waiting: this.waiting,
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
