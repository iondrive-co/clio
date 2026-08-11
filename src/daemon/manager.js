import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { Session } from './session.js';
import {
  writeState,
  readState,
  writeScrollback,
  readScrollback,
  removeScrollback,
  pruneScrollback,
} from './persist.js';

const PROC_POLL_MS = 2000;
const SCROLLBACK_FLUSH_MS = 3000;
const STATE_DEBOUNCE_MS = 400;

function newId() {
  return randomBytes(6).toString('hex');
}

/**
 * Owns every pty on the machine for this user, independent of any window.
 *
 * Browser windows come and go; this object does not. That asymmetry is the
 * entire design: a client disconnect is a UI event, never a process event.
 */
export class SessionManager extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
    this.stateTimer = null;

    this.procTimer = setInterval(() => this.pollProcInfo(), PROC_POLL_MS);
    this.flushTimer = setInterval(() => this.flushScrollback(), SCROLLBACK_FLUSH_MS);
    this.procTimer.unref?.();
    this.flushTimer.unref?.();
  }

  list() {
    return [...this.sessions.values()].sort((a, b) => a.order - b.order);
  }

  get(id) {
    return this.sessions.get(id);
  }

  /**
   * Rebuild tabs from the last saved state. Only reached when the daemon itself
   * died (reboot, crash, deliberate stop) — the ptys are long gone, so every tab
   * comes back with its old output and a new shell in the directory it was in.
   *
   * The shell is reopened here rather than offered: a tab with no pty behind it
   * cannot be typed in, so leaving that decision to the user only ever means a
   * window full of tabs that look usable and are not.
   */
  restoreFromDisk() {
    const { sessions } = readState();
    for (const saved of sessions) {
      if (!saved?.id) continue;
      const session = new Session({
        id: saved.id,
        title: saved.title,
        order: saved.order,
        cwd: saved.cwd,
      });
      session.command = saved.command || null;
      session.seedScrollback(readScrollback(saved.id));
      this.wire(session);
      this.sessions.set(session.id, session);
      // Saved from the window that was showing it, so the first prompt is drawn
      // at roughly the right width instead of 80 columns.
      this.reopen(session, { cols: saved.cols, rows: saved.rows });
    }
    pruneScrollback(new Set(this.sessions.keys()));
    return this.list().length;
  }

  wire(session) {
    session.onData = (data) => this.emit('data', session.id, data);
    session.onExit = () => {
      // A shell that exits on its own is a closed tab, not a crash. Drop it so
      // it is not offered for restore later.
      this.sessions.delete(session.id);
      removeScrollback(session.id);
      this.emit('exit', session.id);
      this.scheduleSave();
    };
  }

  create({ cwd = null, cols = 80, rows = 24, title = null } = {}) {
    const session = new Session({ id: newId(), title, cwd: this.validCwd(cwd) });
    this.wire(session);
    session.spawn({ cwd: session.cwd, cols, rows });
    this.sessions.set(session.id, session);
    this.scheduleSave();
    this.emit('update');
    return session;
  }

  /**
   * Give a restored tab a fresh shell in the directory it was last in.
   *
   * What was running is *not* re-run: replaying a build, a deploy or an ssh
   * session without being asked is not a decision to make on the user's behalf.
   * It is named in the seam instead, so it can be started again if it is wanted.
   */
  reopen(session, { cols, rows } = {}) {
    // Recovered output sits above the new shell, so mark the seam. Without it
    // the dead prompt from before the crash reads as if it were still live.
    const when = new Date().toLocaleString();
    const note = session.command
      ? `──── new shell ${when} — ${session.command} was running here and was not restarted ────`
      : `──── new shell ${when} ────`;
    session.append(`\r\n\x1b[38;5;244m${note}\x1b[0m\r\n`);

    try {
      session.spawn({ cwd: this.validCwd(session.cwd), cols, rows });
    } catch (err) {
      // Say so in the tab itself. The alternative is a pane that silently
      // swallows everything typed into it.
      session.append(`\x1b[38;5;203m──── no shell could be started: ${err.message} ────\x1b[0m\r\n`);
      return session;
    }

    session.command = null;
    this.scheduleSave();
    this.emit('update');
    return session;
  }

  close(id) {
    const session = this.sessions.get(id);
    if (!session) return;

    this.sessions.delete(id);
    removeScrollback(id);

    if (session.pty) {
      session.onExit = null; // deliberate close; skip the exit bookkeeping
      try {
        session.pty.kill();
      } catch {
        /* already gone */
      }
    }

    this.scheduleSave();
    this.emit('update');
  }

  rename(id, title) {
    const session = this.sessions.get(id);
    if (!session) return;
    session.title = title && title.trim() ? title.trim() : null;
    this.scheduleSave();
    this.emit('update');
  }

  reorder(ids) {
    ids.forEach((id, index) => {
      const session = this.sessions.get(id);
      if (session) session.order = index;
    });
    this.scheduleSave();
    this.emit('update');
  }

  write(id, data) {
    this.sessions.get(id)?.write(data);
  }

  resize(id, cols, rows) {
    this.sessions.get(id)?.resize(cols, rows);
  }

  validCwd(cwd) {
    if (cwd && existsSync(cwd)) return cwd;
    return process.env.HOME || '/';
  }

  pollProcInfo() {
    let changed = false;
    for (const session of this.sessions.values()) {
      if (session.refreshProcInfo()) changed = true;
    }
    if (changed) {
      this.scheduleSave();
      this.emit('update');
    }
  }

  flushScrollback() {
    for (const session of this.sessions.values()) {
      if (!session.dirty) continue;
      session.dirty = false;
      writeScrollback(session.id, session.scrollback());
    }
  }

  scheduleSave() {
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      writeState(this.list());
    }, STATE_DEBOUNCE_MS);
    this.stateTimer.unref?.();
  }

  /** Final flush on a deliberate shutdown so nothing is lost. */
  saveNow() {
    if (this.stateTimer) {
      clearTimeout(this.stateTimer);
      this.stateTimer = null;
    }
    for (const session of this.sessions.values()) {
      writeScrollback(session.id, session.scrollback());
    }
    writeState(this.list());
  }
}
