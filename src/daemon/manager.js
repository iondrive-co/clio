import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { Session } from './session.js';
import { cwdOf, environOf, startedAt } from './procinfo.js';
import { observeAgent, resumeAgent, agentFromState, describeAgent } from '../agents/index.js';
import {
  writeState,
  readState,
  writeScrollback,
  readScrollback,
  removeScrollback,
  pruneScrollback,
} from './persist.js';

const PROC_POLL_MS = 2000;

/*
 * Whether a tab that was holding an agent gets it back when its shell has to be
 * rebuilt. On, because a terminal that comes back after a reboot without the
 * conversation that was in it has not really come back.
 *
 * The escape hatch is for the person debugging clio, or for whoever decides
 * they would rather type it themselves — it is read from the daemon's own
 * environment, so `CLIO_AGENT_RESUME=off bin/clio start` is how it is used.
 */
const RESUME_AGENTS = process.env.CLIO_AGENT_RESUME !== 'off';
const SCROLLBACK_FLUSH_MS = 3000;
const STATE_DEBOUNCE_MS = 400;

// Container ids travel in window URLs and come back from whatever a window asks
// for, so keep the shape narrow rather than trusting the string.
const CONTAINER_ID = /^[a-f0-9]{4,32}$/;

function newId() {
  return randomBytes(6).toString('hex');
}

function basename(path) {
  const parts = String(path || '').split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

/**
 * Put the terminal back the way a shell expects to find it.
 *
 * A full-screen program turns things on at startup — mouse reporting, focus
 * reporting, bracketed paste, the alternate screen — and turns them off again
 * on the way out. One that was killed never got to. Those modes belong to the
 * terminal, not the process, so they outlive it: the next shell inherits a
 * terminal that answers every mouse twitch with an escape sequence, which the
 * shell has no idea what to do with and echoes as line noise at the prompt.
 *
 * It goes into the scrollback ahead of the seam rather than being written to
 * the pty, because the replay is what actually reaches a terminal — including
 * the replay into a window that opens tomorrow.
 */
const RESET_MODES = [
  '\x1b[?1049l', // leave the alternate screen
  '\x1b[?1000l\x1b[?1002l\x1b[?1003l', // mouse click, drag and motion reporting off
  '\x1b[?1005l\x1b[?1006l\x1b[?1015l', // and the extended encodings that carry them
  '\x1b[?1004l', // focus in/out reporting off
  '\x1b[?2004l', // bracketed paste off
  '\x1b[?1l\x1b>', // cursor keys and keypad back to normal
  '\x1b[r', // scrolling region back to the whole screen
  '\x1b[?7h\x1b[?25h', // wrap back on, cursor visible again
  '\x1b(B\x1b[0m', // ASCII charset, no leftover colours or bold
].join('');

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
    this.containers = new Map();
    this.nextContainerOrder = 0;
    this.stateTimer = null;
    /**
     * What the launcher last said about the desktop this is running on, handed
     * to every shell opened from here.
     *
     * The daemon's own environment is whatever started it, which may be a shell
     * with no display in it — and a terminal whose tabs cannot open a link, or
     * reach the session bus, is a terminal that quietly does not work.
     */
    this.launchEnv = {};

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

  /* ------------------------------------------------------------ containers */

  /*
   * A container is one window's worth of tabs, and it belongs to the daemon
   * rather than to the window showing it. That is what lets a window be closed
   * and brought back with the same tabs in it, and what stops two windows from
   * being two views of one set of shells — where a tab closed in one vanishes
   * from under the other.
   *
   * A container is either open — a window is showing it, or was showing it when
   * the daemon last went down — or closed, meaning the window was closed and
   * the tabs were put away under a name to be opened again later. `closedAt` is
   * the whole difference, and it is what `clio` reads to decide which windows
   * to put back on screen by itself and which to offer.
   */

  containerList() {
    return [...this.containers.values()].sort((a, b) => a.order - b.order);
  }

  getContainer(id) {
    return this.containers.get(id) || null;
  }

  sessionsIn(containerId) {
    return this.list().filter((s) => s.container === containerId);
  }

  /** Get the named container, creating it if this is the first anyone has heard of it. */
  openContainer(id = null) {
    const wanted = id && CONTAINER_ID.test(id) ? id : newId();
    const existing = this.containers.get(wanted);
    if (existing) return existing;

    const container = {
      id: wanted,
      order: this.nextContainerOrder++,
      name: null,
      closedAt: null,
    };
    this.containers.set(wanted, container);
    this.scheduleSave();
    return container;
  }

  /** Rebuild a container from a saved or handed-over record. */
  absorbContainer(saved) {
    if (!saved?.id || !CONTAINER_ID.test(saved.id)) return null;
    const order = Number.isFinite(saved.order) ? saved.order : this.nextContainerOrder;
    const container = {
      id: saved.id,
      order,
      name: typeof saved.name === 'string' && saved.name.trim() ? saved.name.trim() : null,
      closedAt: Number.isFinite(saved.closedAt) ? saved.closedAt : null,
    };
    this.containers.set(container.id, container);
    this.nextContainerOrder = Math.max(this.nextContainerOrder, order + 1);
    return container;
  }

  /**
   * Put a window away rather than ending it.
   *
   * Closing a window closes the window. The shells in it are the work, not the
   * frame around it, and they carry on running exactly as they do when the
   * daemon is replaced under them — the tabs are simply not on screen for a
   * while. The group keeps a name so it can be told apart from every other one
   * when it is opened again.
   */
  parkContainer(containerId) {
    const container = this.containers.get(containerId);
    if (!container) return 0;

    const sessions = this.sessionsIn(containerId);
    // Nothing to put away: this window's last tab was closed, which is the one
    // way of ending shells that is unambiguously what was asked for.
    if (!sessions.length) {
      this.containers.delete(containerId);
      this.scheduleSave();
      return 0;
    }

    if (!container.name) container.name = this.suggestName(sessions);
    container.closedAt = Date.now();
    this.scheduleSave();
    this.emit('containers');
    return sessions.length;
  }

  /** A window is showing this container again, so it is no longer put away. */
  reviveContainer(containerId) {
    const container = this.containers.get(containerId);
    if (!container || container.closedAt === null) return;
    container.closedAt = null;
    this.scheduleSave();
    this.emit('containers');
  }

  renameContainer(containerId, name) {
    const container = this.containers.get(containerId);
    if (!container) return;
    container.name = name && name.trim() ? name.trim().slice(0, 80) : null;
    this.scheduleSave();
    this.emit('containers');
  }

  /**
   * A name for a window nobody has named, taken from what is in it — the same
   * thing its first tab is labelled with, which is what the person closing it
   * was just looking at. Duplicates are numbered rather than merged: two
   * windows both full of `core` are still two windows.
   */
  suggestName(sessions) {
    const first = sessions[0];
    const base =
      first?.title ||
      (first?.command ? basename(first.command.split(/\s+/)[0]) : '') ||
      basename(first?.cwd || '') ||
      'shell';

    const taken = new Set([...this.containers.values()].map((c) => c.name).filter(Boolean));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) {
      const candidate = `${base} (${n})`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  /** What the window picker shows for one container. */
  describeContainer(container) {
    const sessions = this.sessionsIn(container.id);
    return {
      id: container.id,
      name: container.name || this.suggestName(sessions),
      closedAt: container.closedAt,
      tabs: sessions.map((s) => ({
        id: s.id,
        label: s.title || (s.command ? basename(s.command.split(/\s+/)[0]) : '') || basename(s.cwd) || '~',
        cwd: s.cwd,
      })),
    };
  }

  /**
   * Forget a container whose last tab has gone.
   *
   * Safe to do while a window is still pointing at it: the id is remembered by
   * that window, and opening a tab there brings the container back under the
   * same name.
   */
  forgetContainerIfEmpty(containerId) {
    if (!containerId || this.sessionsIn(containerId).length) return;
    if (this.containers.delete(containerId)) this.scheduleSave();
  }

  /**
   * End a whole window: every shell in it dies and the container is forgotten.
   *
   * Closing a window does not come here — that puts it away, see parkContainer.
   * This is for a group somebody has asked to be rid of, in the one place that
   * offers it: the picker that would otherwise go on listing it forever.
   */
  closeContainer(containerId) {
    for (const session of this.sessionsIn(containerId)) this.close(session.id);
    if (this.containers.delete(containerId)) this.scheduleSave();
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
    const { containers, sessions } = readState();

    for (const saved of containers) this.absorbContainer(saved);

    // Tabs saved before windows were first-class do not name one. They were all
    // being shown by a single window, so that is what they come back as.
    let legacy = null;
    const containerFor = (saved) => {
      if (saved.container && CONTAINER_ID.test(saved.container)) {
        return this.openContainer(saved.container).id;
      }
      if (!legacy) legacy = this.openContainer();
      return legacy.id;
    };

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
      // The process is long dead, so the record comes back without a pid. What
      // it is for is the reopen below.
      session.agent = agentFromState(saved.agent);
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

  /**
   * Take over the sessions of the daemon this process is replacing.
   *
   * Every entry names a master descriptor this process inherited at startup, so
   * the shells are already ours by the time we get here; what is left is to
   * rebuild the tabs around them. Scrollback comes off disk, flushed by the
   * outgoing daemon on its way out, and the ptys carry on mid-sentence: no
   * seam, no redraw, nothing restarted. A shell cannot tell this happened.
   */
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
      // The agent is still running — a handover does not disturb the shells —
      // so its pid comes across with it and nothing has to be found again.
      session.agent = agentFromState(saved.agent, { pid: saved.agentPid ?? null });
      session.seedScrollback(readScrollback(saved.id));
      this.wire(session);
      this.sessions.set(session.id, session);

      if (Number.isInteger(saved.fd)) {
        session.adopt({ fd: saved.fd, pid: saved.pid, cols: saved.cols, rows: saved.rows });
      } else {
        // A tab whose shell had already died has nothing to hand over. Give it
        // one, exactly as a restart from disk would.
        this.reopen(session, { cols: saved.cols, rows: saved.rows });
      }
    }

    pruneScrollback(new Set(this.sessions.keys()));
    this.scheduleSave();
    return this.list().length;
  }

  /**
   * Stop and start reading every pty.
   *
   * Paused for the length of a handover: whatever the shells write while the
   * daemon is changing hands waits in the kernel's buffers and is read by the
   * daemon that takes over, rather than by the one on its way out.
   */
  pauseAll() {
    for (const session of this.sessions.values()) session.pause();
  }

  resumeAll() {
    for (const session of this.sessions.values()) session.resume();
  }

  wire(session) {
    session.onData = (data) => this.emit('data', session.id, data);
    session.onExit = () => {
      // A shell that exits on its own is a closed tab, not a crash. Drop it so
      // it is not offered for restore later.
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

  /**
   * Give a restored tab a fresh shell in the directory it was last in.
   *
   * What was running is *not* re-run: replaying a build, a deploy or an ssh
   * session without being asked is not a decision to make on the user's behalf.
   * It is named in the seam instead, so it can be started again if it is wanted.
   *
   * An agent is the exception, and the only one — see src/agents for why it
   * earns itself. The tab had a conversation in it, the conversation is on disk
   * where the shell that was showing it cannot take it, and reopening it runs
   * nothing that was not already run. The seam says so before it happens.
   */
  reopen(session, { cols, rows } = {}) {
    const plan = RESUME_AGENTS ? resumeAgent(session.agent, { cwd: session.cwd }) : null;

    // Recovered output sits above the new shell, so mark the seam. Without it
    // the dead prompt from before the crash reads as if it were still live.
    const when = new Date().toLocaleString();
    const note = plan
      ? `──── new shell ${when} — ${plan.why} ────`
      : session.command
        ? `──── new shell ${when} — ${session.command} was running here and was not restarted ────`
        : `──── new shell ${when} ────`;
    session.append(`${RESET_MODES}\r\n\x1b[38;5;244m${note}\x1b[0m\r\n`);

    try {
      session.spawn({ cwd: this.validCwd(session.cwd), cols, rows, env: this.launchEnv });
    } catch (err) {
      // Say so in the tab itself. The alternative is a pane that silently
      // swallows everything typed into it.
      session.append(`\x1b[38;5;203m──── no shell could be started: ${err.message} ────\x1b[0m\r\n`);
      return session;
    }

    if (plan) {
      console.log(`[clio] ${session.id}: ${describeAgent(session.agent)} — ${plan.command}`);
      session.typeWhenReady(plan.command);
      // The record is kept, pointing at no process yet: the agent is on its way
      // and the poll will pick it up. Keeping it is also what makes a second
      // crash, before that happens, resume the same conversation again.
      session.agent = { ...session.agent, pid: null, resumedAt: Date.now() };
    } else {
      // Nothing was brought back, so nothing is being held. Saying otherwise
      // would leave the tab offering to resume something that is not there.
      session.agent = null;
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
    this.forgetContainerIfEmpty(session.container);

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
    if (this.pollAgents()) changed = true;
    if (changed) {
      this.scheduleSave();
      this.emit('update');
    }
  }

  /**
   * Notice which tabs are holding an agent, and what would bring it back.
   *
   * Rides on the proc poll rather than watching for anything of its own: the
   * foreground process has just been worked out for every tab, and this is the
   * same question asked of the same answer. What comes back is written down as
   * it is found, because after a reboot /proc is gone and whatever was not
   * saved beforehand never existed.
   */
  pollAgents() {
    const sessions = [...this.sessions.values()];
    // Which conversations are already somebody's, so that two agents open in
    // one directory are not both recorded as the same one.
    const claimed = new Set(
      sessions.map((s) => s.agent?.state?.sessionId).filter(Boolean),
    );

    let changed = false;
    for (const session of sessions) {
      const fg = session.foreground;
      const taken = new Set(claimed);
      if (session.agent?.state?.sessionId) taken.delete(session.agent.state.sessionId);

      const { record, changed: moved } = observeAgent(session.agent, {
        // Read lazily: everything but argv and exe costs a trip to /proc, and
        // most tabs are not agents. Nothing below is touched until an adapter
        // has said the process is one of its own.
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
        },
        taken,
      });

      session.agent = record;
      if (moved) changed = true;
    }
    return changed;
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
      writeState(this.containerList(), this.list());
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
    writeState(this.containerList(), this.list());
  }
}
