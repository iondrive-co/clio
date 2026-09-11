import { spawnPty, adoptPty } from './pty.js';
import { cwdOf, foregroundCommand, somethingInFront } from './procinfo.js';
import { Screen, isNews, lastScreenSwap } from './screen.js';
import { TitleReader, lastTitleIn } from './termtitle.js';
import { extensionToState, extensionTitle } from '../extensions/index.js';

const TAB_SHELL = '/bin/bash';

const SCROLLBACK_BYTES = 512 * 1024;

const UNDERNEATH_BYTES = SCROLLBACK_BYTES / 2;

const SHELL_SETTLE_MS = 250;
const SHELL_READY_MS = 30000;

const QUESTION_HOLD_MS = 120000;

const ANSWER_POLL_MS = 1000;

const UNTYPED_BYTES = 4096;

const BRACKETED_PASTE_START = '\x1b[200~';

const TAIL_BYTES = 2048;

const OSC = /\x1b][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const SHORT_ESCAPE = /\x1b[()#][0-9A-Za-z]|\x1b[=>78]/g;

const REDRAW_MS = 500;

// How long a row has to have been left alone before what is on it counts as
// something to be read rather than something in the middle of being drawn.
export const ROW_STILL_MS = 500;

const ARRIVING_QUIET_MS = 10000;
const ARRIVING_MAX_MS = 120000;

let nextOrder = 0;

function lastBytesOf(text, cap) {
  if (Buffer.byteLength(text) <= cap) return text;
  const from = text.length - cap;
  const feed = text.indexOf('\n', from);
  if (feed !== -1) return text.slice(feed + 1);
  const escape = text.indexOf('\x1b', from);
  return text.slice(escape === -1 ? from : escape);
}

export class Session {
  constructor({ id, title = null, order = null, cwd = null, container = null }) {
    this.id = id;
    this.title = title;
    this.order = order ?? nextOrder++;
    this.cwd = cwd || process.env.HOME;
    this.command = null;
    this.container = container;

    this.foreground = null;
    this.ext = null;
    this.pending = null;
    this.typed = '';
    this.unanswered = 0;
    this.typedAt = null;

    this.termTitle = null;
    this.titles = new TitleReader();
    this.titleMoved = false;
    this.titleAt = 0;

    this.pty = null;
    this.status = 'restorable';
    this.exitCode = null;

    this.cols = 80;
    this.rows = 24;

    this.chunks = [];
    this.bytes = 0;
    this.underneath = [];
    this.underneathBytes = 0;
    this.dirty = false;
    this.unseenOutput = false;
    this.screen = new Screen({ cols: this.cols, rows: this.rows });
    this.seenScreen = null;
    this.waiting = false;
    this.redrawAskedAt = 0;
    this.arrivingUntil = 0;
    this.arrivingCap = 0;

    this.onData = null;
    this.onExit = null;

    if (order !== null && order >= nextOrder) nextOrder = order + 1;
  }

  get shellPid() {
    return this.pty ? this.pty.pid : null;
  }

  spawn({ cwd = this.cwd, cols = this.cols, rows = this.rows, shell = null, env = {} } = {}) {
    const file = shell || TAB_SHELL;
    this.cols = cols;
    this.rows = rows;
    this.cwd = cwd;
    this.termTitle = null;
    this.titleAt = 0;
    this.titles = new TitleReader();
    this.waiting = false;
    this.screen = new Screen({ cols, rows });
    this.seenScreen = null;

    this.take(
      spawnPty({
        file,
        cwd,
        cols,
        rows,
        env: {
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

  adopt({ fd, pid, cols = this.cols, rows = this.rows }) {
    this.cols = cols;
    this.rows = rows;
    this.replayScreen(cols, rows);
    this.take(adoptPty({ fd, pid }));
    return this;
  }

  replayScreen(cols = this.cols, rows = this.rows) {
    const recording = this.scrollback();
    this.screen = new Screen({ cols, rows, known: !!recording });
    if (recording) this.screen.write(recording);
    this.seenScreen = null;
    if (!this.unseenOutput) this.markSeen();
  }

  take(handle) {
    this.pty = handle;
    this.status = 'live';
    this.exitCode = null;

    if (this.typed) {
      const waiting = this.typed;
      this.typed = '';
      handle.write(waiting);
    }

    handle.onData((data) => {
      if (this.pending) this.settlePending();
      if (this.arriving()) this.arrivingUntil = Date.now() + ARRIVING_QUIET_MS;
      this.unanswered = 0;
      this.typedAt = null;
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

  whenReady(done, { cap = SHELL_READY_MS, idle = true } = {}) {
    if (!this.pty) {
      done(false);
      return;
    }
    this.cancelPending(false);
    this.pending = { done, idle, settle: null, deadline: null, held: 0, free: 0, asked: false };
    this.armDeadline(cap);
    this.settlePending();
  }

  armDeadline(ms) {
    this.pending.deadline = setTimeout(() => {
      const waiting = this.pending;
      if (waiting.idle && waiting.held < QUESTION_HOLD_MS && this.atUnansweredQuestion()) {
        waiting.held += ANSWER_POLL_MS;
        this.armDeadline(ANSWER_POLL_MS);
        return;
      }
      this.cancelPending(false);
    }, ms);
    this.pending.deadline.unref?.();
  }

  settlePending() {
    clearTimeout(this.pending.settle);
    this.pending.settle = setTimeout(() => {
      if (this.pending.idle && this.pty && somethingInFront(this.pty.pid)) {
        this.pending.free = 0;
        if (this.atUnansweredQuestion()) this.pending.asked = true;
        this.settlePending();
        return;
      }
      this.pending.free = (this.pending.free || 0) + 1;
      if (this.pending.idle && this.pending.free < 2) {
        this.settlePending();
        return;
      }
      this.cancelPending(true);
    }, SHELL_SETTLE_MS);
    this.pending.settle.unref?.();
  }

  cancelPending(ready) {
    const waiting = this.pending;
    if (!waiting) return null;
    clearTimeout(waiting.settle);
    clearTimeout(waiting.deadline);
    this.pending = null;
    waiting.done(ready, { asked: waiting.asked });
    return waiting;
  }

  typeWhenReady(command, { run = true, onSettled = null } = {}) {
    if (!command) {
      onSettled?.(false);
      return;
    }
    const text = run ? `${command}\r` : command;

    this.whenReady((ready, how) => {
      if (ready) {
        this.beginArrival();
        this.write(text);
      } else if (this.pty) {
        this.append(
          `\x1b[38;5;180m     something else is holding this terminal, so this was left for you:  ${command}\x1b[0m\r\n`,
        );
      }
      onSettled?.(ready, how);
    });
  }

  noteTitle(data) {
    const announced = this.titles.read(data);
    if (announced === null || announced === this.termTitle) return;
    this.termTitle = announced;
    this.titleAt = Date.now();
    this.titleMoved = true;
  }

  takeTitleChange() {
    const moved = this.titleMoved;
    this.titleMoved = false;
    return moved;
  }

  markSeen() {
    this.seenScreen = this.screen.snapshot();
    this.screen.forgetChurn();
  }

  // What is on the screen that was not there when somebody last looked. Rows
  // still being repainted are left out of the count until they hold still, so a
  // tab with an animation in a corner of it is judged on the rest of its screen;
  // MOVING comes back when that is all there was, and the answer may yet change.
  screenIsNew({ now = Date.now(), still = ROW_STILL_MS } = {}) {
    if (!this.screen.sure || this.seenScreen === null) return null;
    return isNews(this.seenScreen, this.screen.snapshot(), { settledBy: now - still });
  }

  append(data) {
    const swap = lastScreenSwap(data);

    if (swap && swap.borrowed && !this.underneath.length) {
      const asked = data.slice(0, swap.at);
      this.underneath = [...this.chunks, asked];
      this.underneathBytes = this.bytes + Buffer.byteLength(asked);
      this.chunks = [];
      this.bytes = 0;
      while (this.underneathBytes > UNDERNEATH_BYTES && this.underneath.length > 1) {
        this.underneathBytes -= Buffer.byteLength(this.underneath.shift());
      }
      this.keep(data.slice(swap.at));
      return;
    }

    if (swap && !swap.borrowed && this.underneath.length) {
      this.chunks = [...this.underneath, ...this.chunks];
      this.bytes += this.underneathBytes;
      this.underneath = [];
      this.underneathBytes = 0;
    }

    this.keep(data);
  }

  keep(data) {
    this.dirty = true;
    if (!data) return;
    this.chunks.push(data);
    this.bytes += Buffer.byteLength(data);

    const room = SCROLLBACK_BYTES - this.underneathBytes;
    while (this.bytes > room && this.chunks.length > 1) {
      const dropped = this.chunks.shift();
      this.bytes -= Buffer.byteLength(dropped);
    }
  }

  scrollback() {
    return this.underneath.join('') + this.chunks.join('');
  }

  cursorLine() {
    let tail = '';
    const parts = [...this.underneath, ...this.chunks];
    for (let i = parts.length - 1; i >= 0 && tail.length < TAIL_BYTES; i--) {
      tail = parts[i] + tail;
    }
    const text = tail.slice(-TAIL_BYTES).replace(OSC, '').replace(CSI, '').replace(SHORT_ESCAPE, '');
    const line = text.slice(text.lastIndexOf('\n') + 1);
    const restart = line.lastIndexOf('\r');
    return (restart === -1 ? line : line.slice(restart + 1)).trimEnd();
  }

  atUnansweredQuestion() {
    if (!this.pty) return false;
    if (!somethingInFront(this.pty.pid)) return false;
    const line = this.cursorLine();
    return line.length > 0 && /[:?]$/.test(line);
  }

  seedScrollback(text) {
    const swap = text ? lastScreenSwap(text) : null;
    const at = swap && swap.borrowed ? swap.at : 0;
    const under = at ? lastBytesOf(text.slice(0, at), UNDERNEATH_BYTES) : '';
    const live = at ? text.slice(at) : text;

    this.underneath = under ? [under] : [];
    this.underneathBytes = under ? Buffer.byteLength(under) : 0;
    this.chunks = live ? [live] : [];
    this.bytes = live ? Buffer.byteLength(live) : 0;
    if (text) this.termTitle = lastTitleIn(text) ?? this.termTitle;
  }

  write(data) {
    if (data && (!data.startsWith('\x1b') || data.startsWith(BRACKETED_PASTE_START))) {
      if (!this.unanswered) this.typedAt = Date.now();
      this.unanswered += data.length;
    }
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
      }
    }
  }

  get fd() {
    return this.pty ? this.pty.fd : null;
  }

  pause() {
    this.pty?.pause();
  }

  resume() {
    this.pty?.resume();
  }

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
        }
      }, 20);
    } catch {
    }
  }

  redrawingForClio() {
    return Date.now() - this.redrawAskedAt < REDRAW_MS;
  }

  beginArrival(now = Date.now()) {
    this.arrivingUntil = now + ARRIVING_QUIET_MS;
    this.arrivingCap = now + ARRIVING_MAX_MS;
  }

  arriving(now = Date.now()) {
    return now < this.arrivingUntil && now < this.arrivingCap;
  }

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

  toJSON() {
    return {
      id: this.id,
      container: this.container,
      title: this.title,
      termTitle: this.termTitle,
      order: this.order,
      cwd: this.cwd,
      command: this.command,
      status: this.status,
      exitCode: this.exitCode,
      unseenOutput: this.unseenOutput,
      unanswered: this.unanswered,
      unansweredFor: this.typedAt ? Math.round((Date.now() - this.typedAt) / 1000) : 0,
      waiting: this.waiting,
      pid: this.shellPid,
      cols: this.cols,
      rows: this.rows,
      ext: this.ext ? { kind: this.ext.kind, title: extensionTitle(this.ext) } : null,
    };
  }

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
      ext: extensionToState(this.ext),
    };
  }
}
