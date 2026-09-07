import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { Session } from './session.js';
import { childEnvirons, cwdOf, environOf, startedAt, markedProcesses } from './procinfo.js';
import {
  observeExtension,
  observeAttention,
  resumeExtension,
  recoverExtension,
  extensionFromState,
  extensionIdentity,
  extensionTitle,
  describeExtension,
} from '../extensions/index.js';
import {
  writeState,
  writeStateAsync,
  readState,
  writeScrollback,
  writeScrollbackAsync,
  readScrollback,
  removeScrollback,
  pruneScrollback,
} from './persist.js';

const PROC_POLL_MS = 2000;

const RESUME_EXTENSIONS = process.env.CLIO_RESUME !== 'off';
const SCROLLBACK_FLUSH_MS = 3000;
const STATE_DEBOUNCE_MS = 400;

const SLOW_WRITE_MS = 1000;
const SLOW_WRITE_REPORT_MS = 30000;

const NOT_ANSWERING_MS = 3000;

const RESTORE_LEAD_MS = 20000;

const RESUME_GAP_MS = 12000;

const ANSWER_POLL_MS = 1000;

const CONTAINER_ID = /^[a-f0-9]{4,32}$/;

const WINDOW_MIN = 120;
const WINDOW_MAX = 32000;
const DESKTOP_REACH = 32000;

function windowGeometry(reported) {
  if (!reported) return null;
  const { x, y, width, height } = reported;
  const within = (n, min, max) => Number.isFinite(n) && n >= min && n <= max;
  if (!within(width, WINDOW_MIN, WINDOW_MAX) || !within(height, WINDOW_MIN, WINDOW_MAX)) return null;
  if (!within(x, -DESKTOP_REACH, DESKTOP_REACH) || !within(y, -DESKTOP_REACH, DESKTOP_REACH)) {
    return null;
  }
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}

function sameGeometry(a, b) {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function newId() {
  return randomBytes(6).toString('hex');
}

function basename(path) {
  const parts = String(path || '').split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

const RESET_MODES = [
  '\x1b7',
  '\x1b[?1049l',
  '\x1b[?1000l\x1b[?1002l\x1b[?1003l',
  '\x1b[?1005l\x1b[?1006l\x1b[?1015l',
  '\x1b[?1004l',
  '\x1b[?2004l',
  '\x1b[?1l\x1b>',
  '\x1b[r',
  '\x1b8',
  '\x1b[?7h\x1b[?25h',
  '\x1b(B\x1b[0m',
].join('');

const CLEAR_BELOW = '\x1b[J';

export class SessionManager extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
    this.containers = new Map();
    this.nextContainerOrder = 0;
    this.stateTimer = null;
    this.launchEnv = {};

    this.resumeQueues = new Map();

    this.writingScrollback = new Set();
    this.savingState = false;
    this.saveStateAgain = false;
    this.stopped = false;
    this.lastSlowWriteReport = 0;

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

  containerList() {
    return [...this.containers.values()].sort((a, b) => a.order - b.order);
  }

  getContainer(id) {
    return this.containers.get(id) || null;
  }

  sessionsIn(containerId) {
    return this.list().filter((s) => s.container === containerId);
  }

  openContainer(id = null) {
    const wanted = id && CONTAINER_ID.test(id) ? id : newId();
    const existing = this.containers.get(wanted);
    if (existing) return existing;

    const container = {
      id: wanted,
      order: this.nextContainerOrder++,
      name: null,
      named: false,
      closedAt: null,
      geometry: null,
    };
    this.containers.set(wanted, container);
    this.scheduleSave();
    return container;
  }

  absorbContainer(saved) {
    if (!saved?.id || !CONTAINER_ID.test(saved.id)) return null;
    const order = Number.isFinite(saved.order) ? saved.order : this.nextContainerOrder;
    const container = {
      id: saved.id,
      order,
      name: typeof saved.name === 'string' && saved.name.trim() ? saved.name.trim() : null,
      named: !!saved.named,
      closedAt: Number.isFinite(saved.closedAt) ? saved.closedAt : null,
      geometry: windowGeometry(saved.geometry),
    };
    this.containers.set(container.id, container);
    this.nextContainerOrder = Math.max(this.nextContainerOrder, order + 1);
    return container;
  }

  parkContainer(containerId) {
    const container = this.containers.get(containerId);
    if (!container) return 0;

    const sessions = this.sessionsIn(containerId);
    if (!sessions.length) {
      this.containers.delete(containerId);
      this.scheduleSave();
      return 0;
    }

    if (!container.name || !container.named) container.name = this.suggestName(sessions, container.id);
    container.closedAt = Date.now();
    this.scheduleSave();
    this.emit('containers');
    return sessions.length;
  }

  reviveContainer(containerId) {
    const container = this.containers.get(containerId);
    if (!container || container.closedAt === null) return;
    container.closedAt = null;
    this.scheduleSave();
    this.emit('containers');
  }

  moveToContainer(id, containerId) {
    const session = this.sessions.get(id);
    if (!session || !this.containers.has(containerId)) return false;
    if (session.container === containerId) return false;

    const from = session.container;
    const last = this.sessionsIn(containerId).reduce((max, s) => Math.max(max, s.order), -1);
    session.container = containerId;
    session.order = last + 1;
    if (from) this.forgetContainerIfEmpty(from);

    this.scheduleSave();
    this.emit('update');
    return true;
  }

  setGeometry(containerId, reported) {
    const container = this.containers.get(containerId);
    if (!container) return;
    const geometry = windowGeometry(reported);
    if (!geometry || sameGeometry(container.geometry, geometry)) return;
    container.geometry = geometry;
    this.scheduleSave();
  }

  renameContainer(containerId, name) {
    const container = this.containers.get(containerId);
    if (!container) return;
    container.name = name && name.trim() ? name.trim().slice(0, 80) : null;
    container.named = !!container.name;
    this.scheduleSave();
    this.emit('containers');
  }

  labelFor(session, fallback = '~') {
    return (
      session?.title ||
      extensionTitle(session?.ext) ||
      (session?.command ? basename(session.command.split(/\s+/)[0]) : '') ||
      basename(session?.cwd || '') ||
      fallback
    );
  }

  suggestName(sessions, self = null) {
    const base = this.labelFor(sessions[0], 'shell');

    const taken = new Set(
      [...this.containers.values()].filter((c) => c.id !== self).map((c) => c.name).filter(Boolean),
    );
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) {
      const candidate = `${base} (${n})`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  describeContainer(container) {
    const sessions = this.sessionsIn(container.id);
    return {
      id: container.id,
      name: container.name || this.suggestName(sessions),
      closedAt: container.closedAt,
      tabs: sessions.map((s) => ({
        id: s.id,
        label: this.labelFor(s),
        cwd: s.cwd,
      })),
    };
  }

  forgetContainerIfEmpty(containerId) {
    if (!containerId || this.sessionsIn(containerId).length) return;
    if (this.containers.delete(containerId)) this.scheduleSave();
  }

  closeContainer(containerId) {
    for (const session of this.sessionsIn(containerId)) this.close(session.id);
    if (this.containers.delete(containerId)) this.scheduleSave();
  }

  restoreFromDisk() {
    const { containers, sessions } = readState();

    this.clearStrays(sessions.map((s) => s?.id).filter(Boolean));

    for (const saved of containers) this.absorbContainer(saved);

    let legacy = null;
    const containerFor = (saved) => {
      if (saved.container && CONTAINER_ID.test(saved.container)) {
        return this.openContainer(saved.container).id;
      }
      if (!legacy) legacy = this.openContainer();
      return legacy.id;
    };

    const rebuilt = [];
    for (const saved of sessions) {
      if (!saved?.id) continue;
      const session = new Session({
        id: saved.id,
        title: saved.title,
        order: saved.order,
        cwd: saved.cwd,
        container: containerFor(saved),
      });
      session.command = saved.command || null;
      session.ext = extensionFromState(saved.ext ?? saved.agent);
      session.seedScrollback(readScrollback(saved.id));
      this.wire(session);
      this.sessions.set(session.id, session);
      rebuilt.push({ session, cols: saved.cols, rows: saved.rows });
    }
    pruneScrollback(new Set(this.sessions.keys()));

    const [first, ...rest] = rebuilt;
    if (!first) return this.list().length;

    const open = ({ session, cols, rows }, then = null) => this.reopen(session, { cols, rows, then });
    const together = (queue) => queue.forEach((item) => open(item));
    const oneAtATime = (queue) => {
      const [next, ...later] = queue;
      if (!next) return;
      open(next, (clear) => (clear ? together(later) : oneAtATime(later)));
    };

    open(first, (clear) => (clear ? together(rest) : oneAtATime(rest)));

    return this.list().length;
  }

  clearStrays(sessionIds) {
    const strays = markedProcesses(sessionIds);
    if (!strays.length) return 0;

    for (const { pid } of strays.slice().reverse()) {
      try {
        process.kill(pid, 'SIGHUP');
      } catch {
      }
    }
    console.log(`[clio] ended ${strays.length} process(es) left over from the last run`);
    return strays.length;
  }

  adoptHandover({ containers = [], sessions = [] }) {
    for (const saved of containers) this.absorbContainer(saved);

    for (const saved of sessions) {
      if (!saved?.id) continue;
      const session = new Session({
        id: saved.id,
        title: saved.title,
        order: saved.order,
        cwd: saved.cwd,
        container: this.openContainer(saved.container).id,
      });
      session.command = saved.command || null;
      session.unseenOutput = !!saved.unseenOutput;
      session.waiting = !!saved.waiting;
      session.ext = extensionFromState(saved.ext ?? saved.agent, {
        pid: saved.extPid ?? saved.agentPid ?? null,
      });
      session.seedScrollback(readScrollback(saved.id));
      if (saved.termTitle) session.termTitle = saved.termTitle;
      this.wire(session);
      this.sessions.set(session.id, session);

      if (Number.isInteger(saved.fd)) {
        session.adopt({ fd: saved.fd, pid: saved.pid, cols: saved.cols, rows: saved.rows });
      } else {
        this.reopen(session, { cols: saved.cols, rows: saved.rows });
      }
    }

    pruneScrollback(new Set(this.sessions.keys()));
    this.scheduleSave();
    return this.list().length;
  }

  pauseAll() {
    this.stopped = true;
    for (const session of this.sessions.values()) session.pause();
  }

  resumeAll() {
    this.stopped = false;
    for (const session of this.sessions.values()) session.resume();
  }

  wire(session) {
    session.onData = (data) => this.emit('data', session.id, data);
    session.onExit = () => {
      this.sessions.delete(session.id);
      removeScrollback(session.id);
      this.forgetContainerIfEmpty(session.container);
      this.emit('exit', session.id, session.container);
      this.scheduleSave();
    };
  }

  create({ container = null, cwd = null, cols = 80, rows = 24, title = null } = {}) {
    const session = new Session({
      id: newId(),
      title,
      cwd: this.validCwd(cwd),
      container: this.openContainer(container).id,
    });
    this.wire(session);
    session.spawn({ cwd: session.cwd, cols, rows, env: this.launchEnv });
    this.sessions.set(session.id, session);
    this.scheduleSave();
    this.emit('update');
    return session;
  }

  reopen(session, { cols, rows, then = null } = {}) {
    const known = resumeExtension(session.ext, { cwd: session.cwd });
    const plan = RESUME_EXTENSIONS ? known : null;

    const lost = plan ? null : known || recoverExtension({ command: session.command, cwd: session.cwd });

    const when = new Date().toLocaleString();
    const note = plan
      ? `──── new shell ${when} — ${plan.why} ────`
      : session.command
        ? `──── new shell ${when} — ${session.command} was running here and was not restarted ────`
        : `──── new shell ${when} ────`;
    session.append(`${RESET_MODES}${CLEAR_BELOW}\r\n\x1b[38;5;244m${note}\x1b[0m\r\n`);
    if (lost) {
      session.append(`\x1b[38;5;180m     to pick that up again:  ${lost.command}\x1b[0m\r\n`);
    }

    session.beginArrival();

    try {
      session.spawn({ cwd: this.validCwd(session.cwd), cols, rows, env: this.launchEnv });
    } catch (err) {
      session.append(`\x1b[38;5;203m──── no shell could be started: ${err.message} ────\x1b[0m\r\n`);
      then?.(false);
      return session;
    }

    if (plan) {
      console.log(`[clio] ${session.id}: ${describeExtension(session.ext)} — ${plan.command}`);
      this.queueResume(session, plan, then);
      session.ext = { ...session.ext, pid: null, resumedAt: Date.now() };
    } else {
      if (then) session.whenReady((ready, how) => then(ready && !how?.asked), { cap: RESTORE_LEAD_MS });
      session.ext = null;
    }

    session.command = null;
    this.scheduleSave();
    this.emit('update');
    return session;
  }

  queueResume(session, plan, then = null) {
    if (!plan.alone) {
      session.typeWhenReady(plan.command, {
        run: plan.run,
        onSettled: (typed, how) => then?.(typed && !how?.asked),
      });
      return;
    }

    const queue = this.resumeQueues.get(plan.kind) || [];
    queue.push({ session, plan, then });
    this.resumeQueues.set(plan.kind, queue);
    if (queue.length === 1) this.nextResume(plan.kind);
  }

  nextResume(kind) {
    const queue = this.resumeQueues.get(kind);
    const head = queue?.[0];
    if (!head) {
      this.resumeQueues.delete(kind);
      return;
    }

    let moved = false;
    let waiting = null;
    const advance = () => {
      if (moved) return;
      moved = true;
      clearTimeout(waiting);
      queue.shift();
      this.nextResume(kind);
    };

    const whenAnswered = () => {
      if (head.session.atUnansweredQuestion()) {
        waiting = setTimeout(whenAnswered, ANSWER_POLL_MS);
        waiting.unref?.();
        return;
      }
      advance();
    };

    head.session.typeWhenReady(head.plan.command, {
      run: head.plan.run,
      onSettled: (typed, how) => {
        head.then?.(typed && !how?.asked);
        if (!typed) {
          advance();
          return;
        }
        waiting = setTimeout(whenAnswered, RESUME_GAP_MS);
        waiting.unref?.();
      },
    });
  }

  close(id) {
    const session = this.sessions.get(id);
    if (!session) return;

    this.sessions.delete(id);
    removeScrollback(id);
    this.forgetContainerIfEmpty(session.container);

    if (session.pty) {
      session.onExit = null;
      try {
        session.pty.kill();
      } catch {
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
    let moved = false;
    for (const session of this.sessions.values()) {
      const quiet =
        session.unanswered > 0 &&
        session.typedAt !== null &&
        Date.now() - session.typedAt >= NOT_ANSWERING_MS;
      if (quiet !== !!session.wasQuiet) {
        session.wasQuiet = quiet;
        moved = true;
      }
      if (session.refreshProcInfo()) changed = true;
      if (session.takeTitleChange()) moved = true;
    }
    if (this.pollExtensions()) changed = true;
    if (changed) this.scheduleSave();
    if (changed || moved) this.emit('update');
  }

  pollExtensions() {
    const sessions = [...this.sessions.values()];

    const holders = new Map();
    const hold = (id, by) => {
      if (!id) return;
      const now = (holders.get(id) || 0) + by;
      if (now > 0) holders.set(id, now);
      else holders.delete(id);
    };
    for (const session of sessions) hold(extensionIdentity(session.ext), 1);

    let changed = false;
    for (const session of sessions) {
      if (!session.pty) continue;

      const fg = session.foreground;

      const was = extensionIdentity(session.ext);
      hold(was, -1);
      const claimed = new Set(holders.keys());

      const { record, changed: moved } = observeExtension(session.ext, {
        foreground: fg && {
          pid: fg.pid,
          argv: fg.argv,
          exe: fg.exe,
          get cwd() {
            return cwdOf(fg.pid);
          },
          get startedAt() {
            return startedAt(fg.pid);
          },
          get env() {
            return environOf(fg.pid);
          },
          get children() {
            return childEnvirons(fg.pid);
          },
        },
        taken: claimed,
        title: session.termTitle,
      });

      session.ext = record;
      hold(extensionIdentity(record), 1);
      if (moved) changed = true;

      const edge = record
        ? observeAttention(record, { termTitle: session.termTitle, titleAt: session.titleAt })
        : null;
      if (edge) this.emit('attention', session.id, edge === 'waiting');
      if (!record && session.waiting) this.emit('attention', session.id, false);
    }
    return changed;
  }

  flushScrollback() {
    if (this.stopped) return;
    for (const session of this.sessions.values()) {
      if (!session.dirty) continue;
      if (this.writingScrollback.has(session.id)) continue;
      session.dirty = false;
      this.writingScrollback.add(session.id);
      const started = Date.now();
      writeScrollbackAsync(session.id, session.scrollback())
        .catch((err) => {
          session.dirty = true;
          console.error(`[clio] could not save scrollback for ${session.id}:`, err.message);
        })
        .finally(() => {
          this.writingScrollback.delete(session.id);
          this.noteWriteTime(Date.now() - started);
        });
    }
  }

  noteWriteTime(ms) {
    if (ms < SLOW_WRITE_MS) return;
    const now = Date.now();
    if (now - this.lastSlowWriteReport < SLOW_WRITE_REPORT_MS) return;
    this.lastSlowWriteReport = now;
    console.error(
      `[clio] ${new Date().toTimeString().slice(0, 8)} the disk took ` +
        `${(ms / 1000).toFixed(1)}s to write a tab's scrollback — ` +
        'the tabs themselves were unaffected',
    );
  }

  scheduleSave() {
    if (this.stopped || this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      if (this.savingState) {
        this.saveStateAgain = true;
        return;
      }
      this.savingState = true;
      const started = Date.now();
      writeStateAsync(this.containerList(), this.list())
        .catch((err) => {
          this.saveStateAgain = true;
          console.error('[clio] could not save state:', err.message);
        })
        .finally(() => {
          this.savingState = false;
          this.noteWriteTime(Date.now() - started);
          if (this.saveStateAgain) {
            this.saveStateAgain = false;
            this.scheduleSave();
          }
        });
    }, STATE_DEBOUNCE_MS);
    this.stateTimer.unref?.();
  }

  saveNow() {
    if (this.stateTimer) {
      clearTimeout(this.stateTimer);
      this.stateTimer = null;
    }
    for (const session of this.sessions.values()) {
      writeScrollback(session.id, session.scrollback());
    }
    writeState(this.containerList(), this.list());
  }
}
