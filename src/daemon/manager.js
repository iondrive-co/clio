import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { Session } from './session.js';
import { cwdOf, environOf, startedAt, markedProcesses } from './procinfo.js';
import {
  observeExtension,
  resumeExtension,
  recoverExtension,
  extensionFromState,
  extensionIdentity,
  extensionTitle,
  describeExtension,
} from '../extensions/index.js';
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
 * Whether a tab that was holding something an extension knows about gets it
 * back when its shell has to be rebuilt. On, because a terminal that comes back
 * after a reboot without the conversation that was in it, or pointing at
 * nowhere instead of at the host it was on, has not really come back.
 *
 * The escape hatch is for the person debugging clio, or for whoever decides
 * they would rather type it themselves — it is read from the daemon's own
 * environment, so `CLIO_RESUME=off bin/clio start` is how it is used.
 */
const RESUME_EXTENSIONS = process.env.CLIO_RESUME !== 'off';
const SCROLLBACK_FLUSH_MS = 3000;
const STATE_DEBOUNCE_MS = 400;

// Container ids travel in window URLs and come back from whatever a window asks
// for, so keep the shape narrow rather than trusting the string.
const CONTAINER_ID = /^[a-f0-9]{4,32}$/;

/*
 * Where a window was, and how big.
 *
 * Reported by the window itself, because a page is the only thing on this side
 * that knows: the daemon does not talk to the desktop, and the browser it asks
 * for a window puts every window after the first wherever it likes regardless of
 * the size it was given. It is kept against the container rather than left to
 * the browser profile so that it belongs to the tabs — the window that comes
 * back with your shells in it comes back the size it was, on the monitor it was
 * on, which for a desktop with three of them is most of what "as it was" means.
 *
 * A maximised window is remembered as its maximised size and comes back as an
 * ordinary window of that size, which looks the same and is not the same. The
 * page has no way to ask whether it is maximised, so this is as close as the
 * information allows.
 */
const WINDOW_MIN = 120;
const WINDOW_MAX = 32000;
// Room for monitors left of and above the primary one, which have negative
// coordinates, without accepting a number that could only be a mistake.
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
      // Whether that name is one somebody typed. A name clio worked out for
      // itself is worked out again next time; see parkContainer.
      named: false,
      closedAt: null,
      // Nothing until a window has told us where it is; see setGeometry.
      geometry: null,
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
      // Files written before names could be told apart hold only ones clio
      // suggested — renaming by hand is newer than they are — so they are
      // free to be suggested again, which is how a window full of `core`
      // becomes the host its first tab is on.
      named: !!saved.named,
      closedAt: Number.isFinite(saved.closedAt) ? saved.closedAt : null,
      // Checked rather than trusted: it has been on disk since before the last
      // reboot, and the desktop it describes may have had a monitor unplugged
      // since. Files written before windows had a size remembered have none,
      // which is a window that opens where the browser puts it, as before.
      geometry: windowGeometry(saved.geometry),
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

    // A name clio chose is chosen again, because what is in the window has
    // moved on since: the tab that was in /home/me/core when it was last put
    // away may be on a host in Falkenstein now, and a picker that still calls
    // it `core` is describing yesterday. A name somebody typed is never
    // touched — that is the whole difference `named` records.
    if (!container.name || !container.named) container.name = this.suggestName(sessions, container.id);
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

  /**
   * Where the window showing this container is on the desktop, as the window
   * itself reports it.
   *
   * Nobody is told: no other window has any use for it, and the only reader is
   * the next time this container is put on screen. The save is the debounced one,
   * so dragging a window from one monitor to another costs one write of the state
   * file rather than one per frame.
   */
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
    // Typed by a person, so it is theirs now and nothing suggests over it —
    // until they clear it again, which hands it back.
    container.named = !!container.name;
    this.scheduleSave();
    this.emit('containers');
  }

  /**
   * What to call a tab that is being listed rather than shown — in the window
   * picker, in `clio status`, or as the name a closed window is put away under.
   *
   * Deliberately one answer short of what a tab on screen is called: the title
   * the program announced is not consulted here, even though the daemon now
   * knows it. A tab is named after the job an agent is on, and that is right for
   * a label that is redrawn every couple of seconds and wrong for a name a
   * window is put away under — `Fixing the parser` was true for a minute in
   * February and is not what anybody will look for it under in March.
   *
   * The rest of the order is the same, and an extension gets its say — a window
   * full of ssh tabs is listed by its hosts rather than four times as `ssh`.
   */
  labelFor(session, fallback = '~') {
    return (
      session?.title ||
      extensionTitle(session?.ext) ||
      (session?.command ? basename(session.command.split(/\s+/)[0]) : '') ||
      basename(session?.cwd || '') ||
      fallback
    );
  }

  /**
   * A name for a window nobody has named, taken from what is in it — the same
   * thing its first tab is labelled with, which is what the person closing it
   * was just looking at. Duplicates are numbered rather than merged: two
   * windows both full of `core` are still two windows.
   */
  suggestName(sessions, self = null) {
    const base = this.labelFor(sessions[0], 'shell');

    // A window being renamed is not competing with itself: without this, one
    // put away twice on the same host comes back as `pf2 (2)`.
    const taken = new Set(
      [...this.containers.values()].filter((c) => c.id !== self).map((c) => c.name).filter(Boolean),
    );
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
        label: this.labelFor(s),
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

    // Before anything is rebuilt: end what is left of the last life. See
    // markedProcesses — these shells outlived the daemon holding their ptys and
    // are unreachable, but still running, and the tab is about to ask for the
    // port forward one of them is holding.
    this.clearStrays(sessions.map((s) => s?.id).filter(Boolean));

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
      // it is for is the reopen below. `agent` is where version 4 kept this,
      // when an agent was the only thing a tab could be holding.
      session.ext = extensionFromState(saved.ext ?? saved.agent);
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
   * End whatever is still running under tabs this daemon is about to rebuild.
   *
   * SIGHUP rather than SIGKILL, because it is the signal these processes should
   * have had when their terminal went and every one of them knows what it
   * means: a shell ends its jobs, an agent closes its transcript, ssh takes its
   * forwards down. Anything that deliberately ignores it — a `nohup`ed job —
   * carries on, which is what its author asked for.
   */
  clearStrays(sessionIds) {
    const strays = markedProcesses(sessionIds);
    if (!strays.length) return 0;

    // Deepest first: a shell that is HUPed while its children are still there
    // will scatter them, and the ones it scatters are the ones holding ports.
    for (const { pid } of strays.slice().reverse()) {
      try {
        process.kill(pid, 'SIGHUP');
      } catch {
        /* already gone, or not ours to signal */
      }
    }
    console.log(`[clio] ended ${strays.length} process(es) left over from the last run`);
    return strays.length;
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
      // Whatever it was holding is still running — a handover does not disturb
      // the shells — so its pid comes across with it and nothing has to be
      // found again.
      session.ext = extensionFromState(saved.ext ?? saved.agent, {
        pid: saved.extPid ?? saved.agentPid ?? null,
      });
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
   * What was running is *not* re-run: replaying a build or a deploy without
   * being asked is not a decision to make on the user's behalf. It is named in
   * the seam instead, so it can be started again if it is wanted.
   *
   * The exceptions are whatever an extension has argued for — see
   * src/extensions, and the two that ship: a conversation, which is on disk
   * where the shell showing it cannot take it, and a connection, which is only
   * a connection. Both run nothing that was not already run. The seam says what
   * is about to happen before it happens, and an extension that is not sure
   * enough can ask for its command to be left at the prompt unrun instead.
   */
  reopen(session, { cols, rows } = {}) {
    const known = resumeExtension(session.ext, { cwd: session.cwd });
    const plan = RESUME_EXTENSIONS ? known : null;

    /*
     * If nothing is being brought back, work out what would have brought it
     * back and say so.
     *
     * Three things can be true here, in descending order of how much clio
     * knows. There is a record and it is being resumed — the usual case, and
     * `plan` covers it. There is a record and it is not being resumed, because
     * somebody turned that off. Or there is no record at all: the daemon that
     * was holding this tab predated the extension that would have written one,
     * which is not a hypothetical — it is how five conversations came back as
     * `claude … was not restarted` one morning, a message that is true and
     * leaves you no better off than a blank tab.
     *
     * In both of the last two the answer is on disk, so the tab says it. It is
     * printed rather than run: without a record this is a guess, and a guess is
     * something to put in front of somebody, not something to execute at them.
     */
    const lost = plan ? null : known || recoverExtension({ command: session.command, cwd: session.cwd });

    // Recovered output sits above the new shell, so mark the seam. Without it
    // the dead prompt from before the crash reads as if it were still live.
    const when = new Date().toLocaleString();
    const note = plan
      ? `──── new shell ${when} — ${plan.why} ────`
      : session.command
        ? `──── new shell ${when} — ${session.command} was running here and was not restarted ────`
        : `──── new shell ${when} ────`;
    session.append(`${RESET_MODES}\r\n\x1b[38;5;244m${note}\x1b[0m\r\n`);
    if (lost) {
      // Brighter than the seam: this is the one line in the tab somebody
      // actually has to read, and they are reading it after a crash.
      session.append(`\x1b[38;5;180m     to pick that up again:  ${lost.command}\x1b[0m\r\n`);
    }

    try {
      session.spawn({ cwd: this.validCwd(session.cwd), cols, rows, env: this.launchEnv });
    } catch (err) {
      // Say so in the tab itself. The alternative is a pane that silently
      // swallows everything typed into it.
      session.append(`\x1b[38;5;203m──── no shell could be started: ${err.message} ────\x1b[0m\r\n`);
      return session;
    }

    if (plan) {
      console.log(`[clio] ${session.id}: ${describeExtension(session.ext)} — ${plan.command}`);
      session.typeWhenReady(plan.command, { run: plan.run });
      // The record is kept, pointing at no process yet: whatever it names is on
      // its way and the poll will pick it up. Keeping it is also what makes a
      // second crash, before that happens, bring the same thing back again —
      // and what makes a command left unrun at the prompt stop being claimed
      // once nobody has pressed Enter on it for long enough.
      session.ext = { ...session.ext, pid: null, resumedAt: Date.now() };
    } else {
      // Nothing was brought back, so nothing is being held. Saying otherwise
      // would leave the tab offering to resume something that is not there.
      session.ext = null;
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
    let moved = false;
    for (const session of this.sessions.values()) {
      if (session.refreshProcInfo()) changed = true;
      // A title belongs to a running process and is never written down, so it is
      // worth telling the windows about and not worth a trip to the disk.
      if (session.takeTitleChange()) moved = true;
    }
    if (this.pollExtensions()) changed = true;
    if (changed) this.scheduleSave();
    if (changed || moved) this.emit('update');
  }

  /**
   * Notice what each tab is holding, and what would bring it back.
   *
   * Rides on the proc poll rather than watching for anything of its own: the
   * foreground process has just been worked out for every tab, and this is the
   * same question asked of the same answer. What comes back is written down as
   * it is found, because after a reboot /proc is gone and whatever was not
   * saved beforehand never existed.
   */
  pollExtensions() {
    const sessions = [...this.sessions.values()];
    // What every tab has claimed, as strings this has no business reading —
    // it is for the extension host to know that two agents open in one
    // directory must not be recorded as the same conversation.
    const claimed = new Set(sessions.map((s) => extensionIdentity(s.ext)).filter(Boolean));

    let changed = false;
    for (const session of sessions) {
      const fg = session.foreground;

      const { record, changed: moved } = observeExtension(session.ext, {
        // Read lazily: everything but argv and exe costs a trip to /proc, and
        // most tabs are holding nothing. Nothing below is touched until an
        // adapter has said the process is one of its own.
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
        taken: claimed,
      });

      session.ext = record;
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
