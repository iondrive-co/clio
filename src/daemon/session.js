import * as pty from 'node-pty';
import { cwdOf, foregroundCommand } from './procinfo.js';

// How much raw output we keep per session. This is what gets replayed on
// reattach and written to disk for the post-reboot fallback.
const SCROLLBACK_BYTES = 512 * 1024;

let nextOrder = 0;

export class Session {
  constructor({ id, title = null, order = null, cwd = null }) {
    this.id = id;
    this.title = title;
    this.order = order ?? nextOrder++;
    this.cwd = cwd || process.env.HOME;
    this.command = null;

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

  /** Boot a real shell for this session. */
  spawn({ cwd = this.cwd, cols = this.cols, rows = this.rows, shell = null } = {}) {
    const file = shell || process.env.SHELL || '/bin/bash';
    this.cols = cols;
    this.rows = rows;

    this.pty = pty.spawn(file, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        CLIO_SESSION: this.id,
      },
    });

    this.status = 'live';
    this.exitCode = null;
    this.cwd = cwd;

    this.pty.onData((data) => {
      this.append(data);
      if (this.onData) this.onData(data);
    });

    this.pty.onExit(({ exitCode }) => {
      this.status = 'exited';
      this.exitCode = exitCode;
      this.pty = null;
      this.command = null;
      if (this.onExit) this.onExit(exitCode);
    });

    return this;
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
    if (!this.pty) return false;
    let changed = false;

    const cwd = cwdOf(this.pty.pid);
    if (cwd && cwd !== this.cwd) {
      this.cwd = cwd;
      changed = true;
    }

    const fg = foregroundCommand(this.pty.pid);
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
      title: this.title,
      order: this.order,
      cwd: this.cwd,
      command: this.command,
      status: this.status,
      exitCode: this.exitCode,
      unseenOutput: this.unseenOutput,
      pid: this.shellPid,
      cols: this.cols,
      rows: this.rows,
    };
  }

  /** What gets persisted so the session can be rebuilt after a reboot. */
  toState() {
    return {
      id: this.id,
      title: this.title,
      order: this.order,
      cwd: this.cwd,
      command: this.command,
      cols: this.cols,
      rows: this.rows,
    };
  }
}
