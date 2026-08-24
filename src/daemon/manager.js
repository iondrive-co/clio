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

/*
 * A write this slow is not clio's doing and not clio's to fix, but it is worth
 * one line in the log: it is what a machine that has stopped answering for a
 * moment looks like from in here. A second is far past anything a page cache
 * does and well short of the tens of seconds a writeback storm takes.
 */
const SLOW_WRITE_MS = 1000;
const SLOW_WRITE_REPORT_MS = 30000;

/*
 * How long the first rebuilt shell gets to itself before the rest follow. The
 * argument for the lead is in restoreFromDisk; this is only the number.
 *
 * It ends the moment that shell reaches its own prompt, so on a machine whose
 * profile has nothing to do it is a few hundred milliseconds and nobody sees
 * it. What it is sized for is the other case — the profile that stops to ask
 * for a passphrase — because it is the answer and not the elapsed time that
 * lets every other tab skip the same work. Twenty seconds is about as long as
 * a person who is watching the restore takes to notice a prompt and type into
 * it, and about as long as a screen full of tabs with no shells in them can be
 * left before it looks broken instead of busy.
 */
const RESTORE_LEAD_MS = 20000;

/*
 * How long one tab's resume is given before the next one starts.
 *
 * Resumes of a kind that asked to go one at a time — see queueResume — and the
 * kind that asks is ssh, for a specific reason: `ControlMaster auto` means the
 * first connection to a host builds a socket the rest ride for free, including
 * through a bastion that would otherwise ask each of them for its own 2FA code.
 * Six dialled at once all miss that socket and all ask.
 *
 * So the gap is about the connection: long enough for the first dial to have
 * built the socket the next one is going to look for, short enough that six
 * hosts are all back inside a minute. It is counted from the moment the line
 * goes into the terminal and not from the moment the tab joined the queue —
 * a profile that takes half a minute to run would otherwise spend the whole gap
 * before its ssh had been dialled at all, and the tab behind it would follow
 * immediately.
 *
 * The gap is not what a *person* is waited for with. That has no length to
 * guess at, and guessing at it was the bug: on 21 August fourteen tabs came
 * back, the first stopped on the bastion's verification code, and the other
 * thirteen were dialled twelve seconds apart into a desktop where nobody had
 * been able to answer it yet — so every one of them missed the socket and every
 * one of them asked for its own code. A question is waited for until it has
 * been answered, however long that is; see nextResume.
 */
const RESUME_GAP_MS = 12000;

/*
 * How often the tab at the head of a queue is asked whether its question has
 * been answered yet. Cheap — the tail of one tab's output and one look in
 * /proc — and a second is well inside the time it takes to type a code.
 */
const ANSWER_POLL_MS = 1000;

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
 *
 * The save and the restore around it are not housekeeping. They are the reason
 * a restored tab reads top to bottom at all.
 *
 * Two of these resets move the cursor, and both move it to the top left of the
 * screen. Leaving the alternate screen puts the cursor back where it was saved
 * on the way in, and a tab that was never on the alternate screen has nothing
 * saved, so it goes to the top; setting the scrolling region homes the cursor
 * by definition. Everything after that — the seam, the new shell's prompt, and
 * whatever is typed into it next — is written from the top of the screen down,
 * over what was on the screen when the daemon died. That is what a restore
 * looked like on 21 August: the old text still covering the screen, and the new
 * text threaded through it from the top.
 *
 * DECSC here and DECRC after them puts the cursor back where the program that
 * died had left it. It is the right thing for the tab that really was on the
 * alternate screen too: a saved cursor belongs to the screen that was active
 * when it was written, so this one lands in the alternate screen's slot and
 * leaves the normal screen's — the shell's own cursor, saved by the program on
 * its way in — for `?1049l` to restore, which is exactly what it is for.
 */
const RESET_MODES = [
  '\x1b7', // remember where the cursor is; the two resets below both move it
  '\x1b[?1049l', // leave the alternate screen
  '\x1b[?1000l\x1b[?1002l\x1b[?1003l', // mouse click, drag and motion reporting off
  '\x1b[?1005l\x1b[?1006l\x1b[?1015l', // and the extended encodings that carry them
  '\x1b[?1004l', // focus in/out reporting off
  '\x1b[?2004l', // bracketed paste off
  '\x1b[?1l\x1b>', // cursor keys and keypad back to normal
  '\x1b[r', // scrolling region back to the whole screen
  '\x1b8', // and the cursor back where the program that died left it
  '\x1b[?7h\x1b[?25h', // wrap back on, cursor visible again
  // Last, because the restore above brings back the charset and the colours
  // that were saved with the cursor, and those were the dead program's.
  '\x1b(B\x1b[0m', // ASCII charset, no leftover colours or bold
].join('');

/*
 * And take what the last frame drew below the cursor off the screen.
 *
 * What is above the cursor is what the program had already said, and it is
 * worth keeping: a conversation, a build's output, the shell's own scrollback.
 * What is below it is the bottom half of a frame that is never going to be
 * finished — an input box nothing is reading, a status line about a process
 * that is gone. Left there, the new shell prints its prompt into the middle of
 * it, and the two sit interleaved on the screen with nothing to say which is
 * which.
 *
 * So everything kept stays above the seam, and the tab reads in the order it
 * happened.
 */
const CLEAR_BELOW = '\x1b[J';

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

    /**
     * Tabs waiting their turn to bring something back, one queue per kind of
     * thing. See queueResume — the queues are empty except in the half-minute
     * after a restore.
     */
    this.resumeQueues = new Map();

    /**
     * Which tabs have a scrollback write in the air, and whether the state file
     * does — see flushScrollback and scheduleSave. Both writes go to the disk
     * without anything waiting on them, so both need to know not to start a
     * second one on top of the first.
     */
    this.writingScrollback = new Set();
    this.savingState = false;
    this.saveStateAgain = false;
    /** Set while handing over, when saveNow is the only write allowed. */
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
   * Move one tab out of the window it is in and into another.
   *
   * Nothing happens to the shell. A pty belongs to the daemon and not to any
   * window, so a tab dragged from one window to the next is a change of which
   * page draws it and nothing else — the process never learns that it moved,
   * which is why this is a line of bookkeeping rather than a re-open. It is the
   * same trick the daemon already lives on, turned sideways: a tab outlives the
   * window it was opened in exactly as it outlives the window being closed.
   *
   * A window left with nothing in it is forgotten, the same way it is when its
   * last tab is closed — the page showing it closes itself, and there is
   * nothing left worth putting away.
   */
  moveToContainer(id, containerId) {
    const session = this.sessions.get(id);
    if (!session || !this.containers.has(containerId)) return false;
    if (session.container === containerId) return false;

    const from = session.container;
    // Last in the row it is joining, until the window that took it says
    // otherwise — which is also where a tab dropped past the end belongs.
    const last = this.sessionsIn(containerId).reduce((max, s) => Math.max(max, s.order), -1);
    session.container = containerId;
    session.order = last + 1;
    if (from) this.forgetContainerIfEmpty(from);

    this.scheduleSave();
    this.emit('update');
    return true;
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
      // The process is long dead, so the record comes back without a pid. What
      // it is for is the reopen below. `agent` is where version 4 kept this,
      // when an agent was the only thing a tab could be holding.
      session.ext = extensionFromState(saved.ext ?? saved.agent);
      session.seedScrollback(readScrollback(saved.id));
      this.wire(session);
      this.sessions.set(session.id, session);
      // Saved from the window that was showing it, so the first prompt is drawn
      // at roughly the right width instead of 80 columns.
      rebuilt.push({ session, cols: saved.cols, rows: saved.rows });
    }
    pruneScrollback(new Set(this.sessions.keys()));

    /*
     * One shell first, and the rest behind it.
     *
     * Rebuilding them all in the same millisecond is a thing no terminal has
     * ever done to a login profile. A person opens tabs one at a time, and a
     * profile that has something to do once — unlock a keyring, put an ssh key
     * into an agent — is written for that and is idempotent afterwards rather
     * than concurrent during. On 15 August 24 tabs came back at 22:48:13, 24
     * copies of `keychain` went for an agent that had just been started empty,
     * 18 of them printed `Problem adding; giving up`, and the key never got in
     * — so the six tabs that then reconnected to hosts had to ask for the
     * passphrase one at a time, on their own, in tabs nobody was looking at.
     *
     * One is enough to fix that, because the profile's own idempotence does the
     * rest: the second keychain finds the key already there and says nothing.
     * So this is a lead and not a queue — the first shell, and then, if it got
     * through, everybody.
     *
     * What the lead is really waiting for is a person, which is why the cap is
     * as long as it is: the first profile is where the one passphrase prompt
     * now appears, and a cap that runs out before it can be answered buys
     * nothing, because it is the answer and not the elapsed time that lets the
     * other 23 skip the work. Against that, every one of those tabs is without
     * a shell until it is over, so it cannot be much longer either.
     *
     * And when it does run out — nobody at the desk, the question still on the
     * screen — the rest do *not* all go at once. That was the old behaviour and
     * it was survivable in the way a fire is survivable: on 24 August it meant
     * sixty-two profiles asking for the same passphrase, forty-one of them
     * still asking ten minutes later. What the lead was buying has not been
     * bought, so the argument for going together has not been made, and the
     * tabs follow one at a time instead — each one its own chance to answer the
     * question, and no tab left without a shell for ever. The first of them to
     * get through its profile cleanly ends that: it has done the work the lead
     * was supposed to do, and everybody behind it goes together.
     */
    const [first, ...rest] = rebuilt;
    if (!first) return this.list().length;

    const open = ({ session, cols, rows }, then = null) => this.reopen(session, { cols, rows, then });
    const together = (queue) => queue.forEach((item) => open(item));
    const oneAtATime = (queue) => {
      const [next, ...later] = queue;
      if (!next) return;
      open(next, (through) => (through ? together(later) : oneAtATime(later)));
    };

    open(first, (through) => (through ? together(rest) : oneAtATime(rest)));

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
      // A handover is not a restore. The shells are the same shells and the
      // agent in this tab is the same agent, still stopped, still waiting for
      // the same answer — so the flashing tab keeps flashing across a reload
      // rather than going quiet until the next time it happens to work.
      session.waiting = !!saved.waiting;
      // Whatever it was holding is still running — a handover does not disturb
      // the shells — so its pid comes across with it and nothing has to be
      // found again.
      session.ext = extensionFromState(saved.ext ?? saved.agent, {
        pid: saved.extPid ?? saved.agentPid ?? null,
      });
      session.seedScrollback(readScrollback(saved.id));
      // Handed over rather than read back out of the buffer, and so it wins
      // over whatever seedScrollback found: the daemon that just stood down
      // was reading this tab's titles the whole time it was up, including the
      // ones that have since scrolled out of the 512K that is kept. Without
      // this, a reload renames every tab that has been quiet since it last
      // said what it was doing — which for a row of agents is most of them,
      // and they all come back called `claude`.
      if (saved.termTitle) session.termTitle = saved.termTitle;
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
  /*
   * Paused means a handover is under way, and saveNow is about to write the last
   * word synchronously. Nothing may start a write of its own from here: an
   * unfinished one landing afterwards would put the file back as it was a moment
   * before. If the successor fails to come up, resumeAll below undoes all of it
   * — including this.
   */
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
   *
   * `then` is called once this tab has got through its profile — and, if it was
   * holding something, once that has been typed into it. It is how the restore
   * holds the rest of the tabs back behind the first; see restoreFromDisk. It
   * runs whatever happens, including when no shell could be started at all,
   * because a restore that stops halfway through is worse than any of the
   * things waiting for it.
   *
   * What it is told is whether the shell ever actually came free — false means
   * the cap ran out with something still in front of it, which on a restore is
   * a profile stopped on a question nobody has answered. The tabs behind this
   * one need that: what they do next depends on whether the work this tab was
   * supposed to do for all of them got done.
   */
  reopen(session, { cols, rows, then = null } = {}) {
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
    session.append(`${RESET_MODES}${CLEAR_BELOW}\r\n\x1b[38;5;244m${note}\x1b[0m\r\n`);
    if (lost) {
      // Brighter than the seam: this is the one line in the tab somebody
      // actually has to read, and they are reading it after a crash.
      session.append(`\x1b[38;5;180m     to pick that up again:  ${lost.command}\x1b[0m\r\n`);
    }

    // Everything this tab draws from here until it goes quiet is clio putting
    // it back — the profile, the resume command being echoed, the agent reading
    // its transcript — and none of it is something to go and read. See
    // Session.beginArrival, and the flag itself in ./index.js.
    session.beginArrival();

    try {
      session.spawn({ cwd: this.validCwd(session.cwd), cols, rows, env: this.launchEnv });
    } catch (err) {
      // Say so in the tab itself. The alternative is a pane that silently
      // swallows everything typed into it.
      session.append(`\x1b[38;5;203m──── no shell could be started: ${err.message} ────\x1b[0m\r\n`);
      then?.(false);
      return session;
    }

    if (plan) {
      console.log(`[clio] ${session.id}: ${describeExtension(session.ext)} — ${plan.command}`);
      this.queueResume(session, plan, then);
      // The record is kept, pointing at no process yet: whatever it names is on
      // its way and the poll will pick it up. Keeping it is also what makes a
      // second crash, before that happens, bring the same thing back again —
      // and what makes a command left unrun at the prompt stop being claimed
      // once nobody has pressed Enter on it for long enough.
      session.ext = { ...session.ext, pid: null, resumedAt: Date.now() };
    } else {
      // Nothing to type, so the only thing left to wait for is the profile.
      if (then) session.whenReady((ready) => then(ready), { cap: RESTORE_LEAD_MS });
      // Nothing was brought back, so nothing is being held. Saying otherwise
      // would leave the tab offering to resume something that is not there.
      session.ext = null;
    }

    session.command = null;
    this.scheduleSave();
    this.emit('update');
    return session;
  }

  /**
   * Bring back what a tab was holding — now, or when it is this tab's turn.
   *
   * Most things have no turn to wait for. Nine conversations reopening together
   * do not notice each other, so they are typed the moment their shells are
   * ready and that is the whole of it.
   *
   * An adapter that asked for `alone` is saying the opposite: that two of these
   * starting at once get in each other's way, and the daemon is the only one
   * that can see the other tabs and do anything about it. ssh is the one that
   * asks, and the reason is in src/ssh — a shared connection to a bastion that
   * six simultaneous dials all miss and all have to authenticate around.
   *
   * One queue per kind rather than one queue: waiting is a promise made between
   * things of the same sort, and there is no reason for an agent to be behind a
   * connection or the other way about.
   */
  queueResume(session, plan, then = null) {
    if (!plan.alone) {
      session.typeWhenReady(plan.command, { run: plan.run, onSettled: (typed) => then?.(typed) });
      return;
    }

    const queue = this.resumeQueues.get(plan.kind) || [];
    queue.push({ session, plan, then });
    this.resumeQueues.set(plan.kind, queue);
    if (queue.length === 1) this.nextResume(plan.kind);
  }

  /**
   * Type the resume at the head of a queue, and start the one after it once
   * this one has stopped needing the desk to itself.
   *
   * Two different waits, because two different things are being waited for.
   * The gap is a length of time and is about the connection: a socket takes a
   * moment to appear, and the tab behind this one must not go looking for it
   * before it is there. A question is not a length of time at all — what the
   * first connection is buying for the rest is an answer, a passphrase or a
   * verification code, and only a person has that. So a tab stopped at one is
   * waited for until it has been answered, and the gap does not run out from
   * under it.
   *
   * What ends the wait either way is the tab itself: an ssh that connects, or
   * fails, or is interrupted, leaves nothing on the line for anyone to answer,
   * and the queue moves on the next time it looks.
   */
  nextResume(kind) {
    const queue = this.resumeQueues.get(kind);
    const head = queue?.[0];
    if (!head) {
      this.resumeQueues.delete(kind);
      return;
    }

    // Once: the gap, the question and the shell can all get here, and shifting
    // twice would step over a tab's resume without ever typing it.
    let moved = false;
    let waiting = null;
    const advance = () => {
      if (moved) return;
      moved = true;
      clearTimeout(waiting);
      queue.shift();
      this.nextResume(kind);
    };

    /*
     * The gap has run out. Whether that is enough depends on what the tab is
     * doing with it: a connection that is through, or that has failed, or that
     * is still sitting on its banner has had its turn and the next one can go.
     * One that is stopped at a question has *not* had its turn — nothing it was
     * dialled for has happened yet, and the whole point of going one at a time
     * is that the answer to that question is what the rest are waiting for. So
     * it is left alone until somebody answers it, for as long as that takes.
     *
     * Nothing is lost by waiting. A tab further down the queue shows the seam
     * naming the host it is about to dial, and a person who does not want to
     * wait can dial it themselves — while the alternative, going ahead, is
     * thirteen more tabs each stopping on a question of its own.
     */
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
      onSettled: (typed) => {
        head.then?.(typed);
        // Never typed, because something else had the terminal for the whole of
        // its wait. Nothing was dialled, so there is nothing to give room to.
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

    /*
     * What every tab has claimed, as strings this has no business reading — it
     * is for the extension host to know that two agents open in one directory
     * must not be recorded as the same conversation.
     *
     * Counted rather than collected, and kept up to date as the loop goes, and
     * both of those are the same bug seen from two sides. It was built once
     * from the records this pass started with and then never touched again, so
     * two tabs that both changed their minds in one pass could change them to
     * the same thing — which on 15 August is how two tabs in ~/ops came back
     * running `claude --resume f7147610`, the same conversation, twice. And the
     * count is what lets a tab find its own claim already taken: one entry with
     * two holders survives the subtraction below, so the tab is asked to pick
     * again instead of quietly keeping the collision.
     */
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
      const fg = session.foreground;

      // Everything anybody *else* is holding, which is this tab's own claim put
      // down for the length of the question and picked back up after it.
      const was = extensionIdentity(session.ext);
      hold(was, -1);
      const claimed = new Set(holders.keys());

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
          // What this process has started since it started, which is where a
          // program that generated an id for itself after exec can be caught
          // saying so. See childEnvirons, and SESSION_ENV in
          // src/agents/claude.js: it is the difference between proving which
          // conversation is in this tab and guessing from a directory that
          // every tab in a repository shares.
          get children() {
            return childEnvirons(fg.pid);
          },
        },
        taken: claimed,
      });

      session.ext = record;
      hold(extensionIdentity(record), 1);
      if (moved) changed = true;

      /*
       * And, having just looked at what is in the tab, whether it is working or
       * waiting to be answered.
       *
       * Asked here rather than on a poll of its own because this is where the
       * record is: the answer is about the same process that has just been
       * identified, and the title it is being read from arrived in this daemon
       * without anybody having to go and look for it.
       *
       * Reported and not acted on. Whether an announcement becomes a tab
       * flashing depends on whether anyone is looking at that tab, and which
       * tabs are on screen is a thing only ./index.js knows — the manager has
       * no windows.
       */
      const edge = record
        ? observeAttention(record, { termTitle: session.termTitle, titleAt: session.titleAt })
        : null;
      if (edge) this.emit('attention', session.id, edge === 'waiting');
      // Nothing left in the tab to be waiting for: whatever it was has exited,
      // or somebody typed exit, and a tab that goes on flashing after that is
      // flashing about a process that is not there.
      if (!record && session.waiting) this.emit('attention', session.id, false);
    }
    return changed;
  }

  /*
   * Write down what has been on screen, without ever waiting for the disk.
   *
   * See atomicWriteAsync in persist.js for why not waiting is the point: this
   * runs every three seconds, and the file it writes for a busy tab is half a
   * megabyte of it. A tab whose write is still going is left dirty and picked
   * up on a later tick — what it writes then is a superset of what this one
   * would have written, so nothing is lost by skipping it.
   */
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
          // Unwritten is still unwritten: let the next tick try again.
          session.dirty = true;
          console.error(`[clio] could not save scrollback for ${session.id}:`, err.message);
        })
        .finally(() => {
          this.writingScrollback.delete(session.id);
          this.noteWriteTime(Date.now() - started);
        });
    }
  }

  /*
   * A disk that took seconds to accept half a megabyte is worth saying out loud
   * once, because it is the answer to a question somebody is otherwise left
   * guessing at: everything else on the machine stopped for a moment, and clio
   * was one of the things waiting rather than the thing at fault. Once every
   * half minute at most — a slow disk is slow for every tab at once, and the
   * log is no use if the episode fills it.
   */
  noteWriteTime(ms) {
    if (ms < SLOW_WRITE_MS) return;
    const now = Date.now();
    if (now - this.lastSlowWriteReport < SLOW_WRITE_REPORT_MS) return;
    this.lastSlowWriteReport = now;
    // With the time on it, because the whole use of this line is being lined up
    // against something that happened at a particular moment — a window that
    // froze, a commit that landed — and nothing else in this log is stamped.
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
      // One at a time, and if anything asked to be saved while the last write
      // was in the air, save again after it: the file has to end up holding the
      // tabs as they are now, not as they were when the write started.
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
