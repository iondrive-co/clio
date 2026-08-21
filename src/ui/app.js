/* clio — terminal UI. The window is a viewer; the daemon owns the processes. */

const { Terminal } = window;
const { FitAddon } = window.FitAddon;
const { WebLinksAddon } = window.WebLinksAddon;

// xfce4-terminal's compiled-in defaults, verbatim — the palette it uses when
// terminalrc carries no ColorPalette line. clio is a viewer for shells that
// would otherwise be running there, so a prompt, a diff or a build log has to
// come out the same colour in both.
//
// The normal-intensity half is fully saturated on purpose. Any scheme that
// softens it to clear a contrast floor (One Dark and friends) reads as washed
// out next to the real thing, which is the whole reason this is not one.
const THEME = {
  background: '#000000',
  foreground: '#ffffff',
  cursor: '#ffffff',
  cursorAccent: '#000000',
  // VTE draws an unstyled selection as reverse video. xterm.js only takes a
  // fixed pair, so this is that effect for the common case rather than the
  // per-cell inversion xfce4-terminal actually performs.
  selectionBackground: '#ffffff',
  selectionForeground: '#000000',
  black: '#000000',
  red: '#aa0000',
  green: '#00aa00',
  yellow: '#aa5500',
  blue: '#0000aa',
  magenta: '#aa00aa',
  cyan: '#00aaaa',
  white: '#aaaaaa',
  brightBlack: '#555555',
  brightRed: '#ff5555',
  brightGreen: '#55ff55',
  brightYellow: '#ffff55',
  brightBlue: '#5555ff',
  brightMagenta: '#ff55ff',
  brightCyan: '#55ffff',
  brightWhite: '#ffffff',
};

const FONT_FAMILY = '"Liberation Mono", "DejaVu Sans Mono", ui-monospace, monospace';

// Starting point only: xfce4-terminal's "Liberation Mono 11" at 96 DPI, since
// Pango sizes are points and 11pt = 11 * 96/72 CSS pixels. The arrows in the
// tab row override it, and that choice is what sticks from then on.
const DEFAULT_FONT_SIZE = (11 * 96) / 72;
const FONT_MIN = 8;
const FONT_MAX = 40;
const FONT_KEY = 'clio.fontSize';

// A pane that has not been laid out yet measures as a couple of cells. Resizing
// a pty to 2x1 would mangle whatever is running in it, so refuse anything below
// a usable floor and keep the last good size instead.
const MIN_COLS = 20;
const MIN_ROWS = 5;

const el = {
  tabs: document.getElementById('tabs'),
  newtab: document.getElementById('newtab'),
  newwindow: document.getElementById('newwindow'),
  panes: document.getElementById('panes'),
  status: document.getElementById('status'),
  ctxmenu: document.getElementById('ctxmenu'),
  picker: document.getElementById('picker'),
  fontUp: document.getElementById('font-up'),
  fontDown: document.getElementById('font-down'),
  devbadge: document.getElementById('devbadge'),
};

// ----------------------------------------------------------------- font size

function loadFontSize() {
  try {
    const saved = Number(localStorage.getItem(FONT_KEY));
    if (Number.isFinite(saved) && saved >= FONT_MIN && saved <= FONT_MAX) return saved;
  } catch {
    /* storage unavailable */
  }
  return DEFAULT_FONT_SIZE;
}

let fontSize = loadFontSize();

/**
 * Resize the text in every terminal, and remember it.
 *
 * Only the visible pane can be measured, so only it is refitted here; the rest
 * carry the new size and work out their grid when they are next shown, which
 * activate() already does.
 */
function setFontSize(next) {
  const clamped = Math.min(FONT_MAX, Math.max(FONT_MIN, next));
  if (clamped === fontSize) {
    updateFontButtons();
    return;
  }

  fontSize = clamped;
  try {
    localStorage.setItem(FONT_KEY, String(fontSize));
  } catch {
    /* setting simply will not persist */
  }

  for (const pane of panes.values()) pane.term.options.fontSize = fontSize;
  resizeActive();
  updateFontButtons();
}

// Step to whole pixels, so the fractional starting size snaps to something
// predictable the first time either arrow is used.
const stepUp = () => setFontSize(Math.floor(fontSize) + 1);
const stepDown = () => setFontSize(Math.ceil(fontSize) - 1);

/*
 * Nothing guards closing a window any more, and nothing should.
 *
 * There used to be a browser dialog here, because closing a window ended every
 * shell in it. It does not: the tabs are put away under a name and come back
 * from the picker, so the question it asked no longer has anything behind it.
 */

function updateFontButtons() {
  const shown = Number.isInteger(fontSize) ? fontSize : fontSize.toFixed(1);
  el.fontUp.disabled = fontSize >= FONT_MAX;
  el.fontDown.disabled = fontSize <= FONT_MIN;
  el.fontUp.title = `Larger text (currently ${shown}px)`;
  el.fontDown.title = `Smaller text (currently ${shown}px)`;
}

/** Server-side session metadata, keyed by id. */
const sessions = new Map();
/** Local view state (xterm instance + DOM), keyed by id. */
const panes = new Map();
/** Last title a program announced via OSC, keyed by id. */
const termTitles = new Map();

let activeId = null;
let order = [];
/**
 * Which container — which window's worth of tabs — this page is showing.
 *
 * The daemon owns containers; a window is only ever a view of one. Holding the
 * id here, in the URL, and nowhere else is what lets this window be closed and
 * come back with the same tabs, and what stops it from ever showing another
 * window's shells.
 */
let containerId = new URLSearchParams(location.search).get('c') || '';
/**
 * This window has not been told which tabs it is showing yet.
 *
 * It opened onto the picker: there are windows put away, and which of them —
 * or none of them — this frame becomes is the user's to say. Everything that
 * would otherwise happen to an empty window, opening a first tab above all,
 * waits for that answer.
 */
let picking = new URLSearchParams(location.search).get('pick') === '1';
/** The name this window was given, if it has one. */
let windowName = null;
let ws = null;
let reconnectDelay = 250;
let HOME = '';
let bootstrapped = false;
// Set when the daemon is reachable but refuses this window's credentials.
let disowned = false;
// Set when the daemon closed our socket to make way for a new one running the
// code on disk now; see connect().
let daemonReplaced = false;
let lastTabsSignature = null;
let renaming = false;

// ---------------------------------------------------------------- connection

// The token arrives in the URL, is exchanged for an HttpOnly cookie by the
// server, and is then scrubbed from the address bar. From here on the cookie
// authenticates us — including across reloads, which the URL could not do.
//
// The container id stays: it is this window's identity, and a reload that lost
// it would come back showing somebody else's tabs.
function query() {
  const parts = [];
  if (containerId) parts.push(`c=${encodeURIComponent(containerId)}`);
  // Kept in the address bar as well, so that reloading a window still on the
  // picker comes back to the picker rather than quietly opening a shell.
  if (picking) parts.push('pick=1');
  return parts.length ? `?${parts.join('&')}` : '';
}

function rememberContainer() {
  history.replaceState(null, '', `${location.pathname}${query()}`);
}

if (new URLSearchParams(location.search).has('token')) rememberContainer();

function connect() {
  if (disowned) return;
  ws = new WebSocket(`ws://${location.host}/${query()}`);

  ws.onopen = () => {
    // The daemon that dropped us was making way for one running the code on
    // disk now. The shells came across untouched, but this page is still the
    // version that was served before the swap — so it is one reload behind the
    // clio the user just asked for, and every window has to be told before it
    // is worth having asked. Nothing is lost: the tabs are in the daemon.
    if (daemonReplaced) {
      location.reload();
      return;
    }

    reconnectDelay = 250;
    disowned = false;
    hideStatus();
    // A reconnect means every pane's view is stale: drop what is on screen and
    // let the server replay authoritative scrollback.
    for (const pane of panes.values()) {
      pane.attached = false;
      pane.term.reset();
    }
    if (activeId) {
      attach(activeId);
      // Say again which tab is on screen. The daemon forgot when the socket
      // went — a reconnect is a new client, and a client that has not said
      // what it is watching has every tab in its window counted as unwatched.
      // Nothing here has changed for the user, so nothing should look as
      // though it has: the repaint that attaching provokes in a full-screen
      // program would otherwise land as unseen activity on the very tab they
      // are looking at, and stay red until they clicked on it.
      send({ t: 'focus', id: activeId });
    }
  };

  ws.onmessage = (event) => handle(JSON.parse(event.data));

  ws.onclose = (event) => {
    // Drops the daemon was working on died with the socket, and each one is
    // holding a file the browser cannot let go of until we do.
    dropsInFlight.clear();
    // 1012 is the daemon saying it is being replaced, not that it has gone: a
    // successor is already coming up with these shells still running. Backing
    // off would leave the window dark for seconds after it could have returned.
    if (event.code === 1012) {
      reconnectDelay = 250;
      daemonReplaced = true;
    }
    if (!disowned) reconnect();
  };

  ws.onerror = () => ws.close();
}

/**
 * Work out *why* the connection failed before deciding what to tell the user.
 *
 * A daemon that is merely down will come back and accept us again, so we wait.
 * A daemon that is up but will not have us is never going to change its mind,
 * and silently retrying forever is how a window ends up looking alive while
 * every button does nothing.
 */
async function reconnect() {
  let verdict;
  let command = 'clio';
  try {
    const res = await fetch('/auth', { cache: 'no-store' });
    verdict = res.status === 403 ? 'rejected' : 'ok';
    if (verdict === 'rejected') {
      // The daemon knows where it was installed; quote it back rather than
      // assuming `clio` is on the user's PATH.
      const body = await res.json().catch(() => null);
      if (body?.command) command = body.command;
    }
  } catch {
    verdict = 'down';
  }

  if (verdict === 'rejected') {
    disowned = true;
    showDeadScreen(command);
    return;
  }

  showStatus(
    verdict === 'down'
      ? 'Waiting for the clio daemon to come back…'
      : 'Reconnecting to the clio daemon…',
  );
  setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 5000);
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
    return;
  }
  // Never let a click look like it worked when nothing was sent.
  if (disowned) showDeadScreen();
  else showStatus('Not connected to the clio daemon yet — that did nothing.', 3000);
}

/*
 * A window on its way out says so, while there is still something here to say
 * it with.
 *
 * Closing a window and having its page killed are the same event from the
 * daemon's side: the socket drops, and nothing comes back for the tabs. They
 * need opposite answers — one is somebody putting a window away, the other is
 * a window sitting on screen with Chrome's error page in it and no way to say
 * so — and the only thing that can tell them apart is this. A page being torn
 * down gets to speak; a renderer the system killed does not, and that silence
 * is what the daemon reads. pagehide covers the lot: a close, a reload, a
 * navigation.
 *
 * sendBeacon rather than the socket, because this is the one message that has
 * to leave: a frame written into a WebSocket while the page is being taken
 * apart may never go anywhere, and a goodbye that was lost reads exactly like
 * a window that was killed.
 */
addEventListener('pagehide', () => {
  if (!containerId) return;
  const url = `/gone?c=${encodeURIComponent(containerId)}`;
  if (navigator.sendBeacon?.(url)) return;
  // No sendBeacon: the socket is all there is, and it may still flush.
  try {
    ws?.send(JSON.stringify({ t: 'gone' }));
  } catch {
    /* going anyway */
  }
});

/**
 * Say out loud when this window belongs to a sandbox.
 *
 * A daemon started with CLIO_DEV=1 and its own XDG dirs has its own state, port
 * and shells, and its windows are pixel-identical to the real ones. The badge
 * and the title are what stop a command meant for a throwaway shell from
 * landing in a real one.
 */
function setDev(dev) {
  if (el.devbadge) el.devbadge.toggleAttribute('hidden', !dev);
  const title = dev ? 'clio (dev)' : 'clio';
  if (document.title !== title) document.title = title;
}

function handle(msg) {
  switch (msg.t) {
    case 'sessions':
      // The daemon has the last word on which container this is: it names one
      // when we arrive without an id, and again if the one we asked for is gone.
      // Being handed a different one is also the answer to the picker — the
      // only thing that moves a window from one set of tabs to another.
      if (msg.container && msg.container !== containerId) {
        containerId = msg.container;
        settle();
      }
      windowName = msg.name || null;
      setDev(msg.dev);
      // Where this window belongs on the desktop — once for the tabs it opened
      // onto, and again if it takes on another window's from the picker.
      if (!picking && placedFor !== containerId) {
        placedFor = containerId;
        applyGeometry(msg.geometry);
      }
      syncSessions(msg.sessions, msg.home);
      refreshTitle();
      break;

    // The windows that were closed and kept, for a window that has not been
    // told which tabs it is showing yet.
    case 'groups':
      if (!picking) break;
      // Nothing to choose between: the last one was taken by another window
      // while this was on its way up. Asking would be asking about an empty
      // list, so this becomes an ordinary new window.
      if (!msg.groups?.length && el.picker.hidden) {
        chooseNewWindow();
        break;
      }
      renderPicker(msg.groups || [], msg.error);
      break;

    // The page that was in this window before this one was killed rather than
    // closed — the renderer holding a window is the largest thing on the
    // desktop once there is a day's scrollback in it, so it is the first thing
    // the system takes when it runs out of memory. Chrome put its own error
    // page here in the meantime, which could say nothing about clio or about
    // the shells, so this says it now that there is somewhere to say it.
    case 'killed':
      showStatus(
        'This window’s page was killed — out of memory, most likely. ' +
          'Nothing in these tabs was lost; the shells kept running throughout.',
        12000,
      );
      break;

    // The UI files on disk changed. Nothing here is compiled or cached, so the
    // new version is one reload away — and the shells are in the daemon, which
    // is not reloading. Whatever was on screen comes straight back.
    case 'reload':
      location.reload();
      break;

    // Only ever sent when opening a window failed; a window that appeared
    // speaks for itself.
    case 'window':
      if (!msg.ok) showStatus(`Could not open a new window — ${msg.error}`, 6000);
      break;

    // A tab pulled out into a window of its own that never got one. It has been
    // put back where it was dragged from, so nothing is lost but the gesture.
    case 'tab':
      if (!msg.ok) showStatus(`Could not open a window for that tab — ${msg.error}`, 6000);
      break;

    // Same bargain as a window: only ever sent when the click went nowhere. A
    // browser that came up says so by being on screen.
    case 'link':
      if (!msg.ok) showStatus(`Could not open that link — ${msg.error}`, 6000);
      break;

    case 'created':
      sessions.set(msg.id, msg.session);
      ensurePane(msg.id);
      panes.get(msg.id).attached = true;
      activate(msg.id);
      renderTabs();
      break;

    case 'attached': {
      sessions.set(msg.id, msg.session);
      const pane = ensurePane(msg.id);
      pane.attached = true;
      pane.term.reset();
      if (msg.scrollback) replay(pane, msg.scrollback);
      renderTabs();
      break;
    }

    case 'data': {
      const pane = panes.get(msg.id);
      if (pane) pane.term.write(msg.data);
      break;
    }

    // Something dropped was not on the daemon's disk anywhere: it wants the
    // bytes so it can keep a copy to point at.
    case 'dropneed':
      sendDropBytes(msg.drop, Array.isArray(msg.need) ? msg.need : []);
      break;

    // What a drop came to, ready to go into the tab it landed on.
    case 'droptext':
      dropsInFlight.delete(msg.drop);
      if (msg.text) {
        hideStatus();
        pasteInto(msg.id, msg.text);
      }
      if (msg.note) showStatus(msg.note, 8000);
      break;

    case 'exit':
    case 'gone':
      removePane(msg.id);
      sessions.delete(msg.id);
      renderTabs();
      break;

    default:
      break;
  }
}

// ------------------------------------------------------------------ sessions

function syncSessions(list, home) {
  if (home) HOME = home;
  const seen = new Set();
  for (const meta of list) {
    sessions.set(meta.id, meta);
    seen.add(meta.id);
  }
  for (const id of [...sessions.keys()]) {
    if (!seen.has(id)) {
      sessions.delete(id);
      removePane(id);
    }
  }

  order = list.slice().sort((a, b) => a.order - b.order).map((m) => m.id);

  if (!sessions.size) {
    // Still on the picker: this window is empty because it has not been told
    // what to be yet, and opening a shell in it would be answering for the user.
    if (picking) return;
    // Opening onto an empty daemon means a fresh start; running out of tabs
    // later means the user closed the last one, which should close the window.
    if (bootstrapped) {
      window.close();
      // If the browser refuses to close a window it did not open, keep a shell
      // around rather than leaving a dead window with nothing in it.
      setTimeout(() => {
        if (!sessions.size) newTab();
      }, 250);
    } else {
      bootstrapped = true;
      newTab();
    }
    return;
  }
  bootstrapped = true;
  // A tab dragged in from another window: it is ours as of this payload, so put
  // it on screen, which is what dropping it here asked for. One payload only —
  // if it is not in this one the move did not happen, and waiting for a later
  // one would mean an unrelated update bringing an old drag back to life.
  const arrived = adopting;
  adopting = null;
  if (arrived && sessions.has(arrived)) {
    activate(arrived);
  } else if (!activeId || !sessions.has(activeId)) {
    activate(order[0]);
  }
  renderTabs();
}

function newTab() {
  const cwd = activeId ? sessions.get(activeId)?.cwd : null;
  const size = measure();
  send({ t: 'create', cwd, cols: size.cols, rows: size.rows });
}

/**
 * Open a second window, with its own tabs and its own shell.
 *
 * It starts where this tab is, the way any terminal's "open terminal here"
 * does — a new window is nearly always the same work carried on somewhere
 * beside it, not a trip back to the home directory.
 *
 * The daemon does the opening — a page cannot spawn a browser — and gives it a
 * container of its own, so the two windows are separate from the moment the
 * new one exists rather than from whenever it gets around to connecting.
 */
function newWindow() {
  const cwd = activeId ? sessions.get(activeId)?.cwd : null;
  send({ t: 'newwindow', cwd });
}

// -------------------------------------------------------------- window picker

/*
 * Which set of tabs this window is going to be.
 *
 * Closing a window puts its tabs away rather than ending them, so over a few
 * days there are several sitting in the daemon with shells still running in
 * them. A window that opens while any of those exist opens here first: the list
 * of what is waiting, and the choice to take one or start something new. It is
 * the only screen in clio that is not a terminal, and it is on screen for one
 * click.
 */

/** Held while a name is being typed, so a push from the daemon cannot eat it. */
let pickerEditing = false;
/** Which group is asking to be confirmed before its shells are ended. */
let confirmingDiscard = null;
let lastGroups = [];

/** This window now knows what it is showing; the picker's work is done. */
function settle() {
  picking = false;
  confirmingDiscard = null;
  hidePicker();
  rememberContainer();
}

function hidePicker() {
  el.picker.hidden = true;
  el.picker.replaceChildren();
}

function ago(when) {
  if (!when) return 'just now';
  const seconds = Math.max(0, Math.round((Date.now() - when) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function renderPicker(groups, error) {
  lastGroups = groups;
  if (pickerEditing) return;

  refreshTitle();
  el.picker.replaceChildren();

  const card = document.createElement('div');
  card.className = 'picker-card';

  const heading = document.createElement('h1');
  heading.textContent = 'Open a window';
  card.append(heading);

  const sub = document.createElement('p');
  sub.className = 'picker-sub';
  sub.textContent = groups.length
    ? 'These windows were closed, but their shells never stopped. Pick one up where you left it, or start something new.'
    : 'Nothing is waiting. Every window you closed has been opened again.';
  card.append(sub);

  if (error) {
    const warning = document.createElement('p');
    warning.className = 'picker-error';
    warning.textContent = error;
    card.append(warning);
  }

  const list = document.createElement('div');
  list.className = 'picker-list';
  for (const group of groups) list.append(renderGroup(group));
  card.append(list);

  const fresh = document.createElement('button');
  fresh.className = 'picker-new';
  fresh.textContent = 'New window';
  fresh.onclick = () => chooseNewWindow();
  card.append(fresh);

  el.picker.append(card);
  el.picker.hidden = false;
  fresh.focus();
}

function renderGroup(group) {
  const row = document.createElement('div');
  row.className = 'group';

  if (confirmingDiscard === group.id) {
    const question = document.createElement('div');
    question.className = 'group-question';
    question.textContent = `Discard “${group.name}” and end its ${group.tabs.length} shell${
      group.tabs.length === 1 ? '' : 's'
    }?`;
    row.append(question);

    const yes = document.createElement('button');
    yes.className = 'group-confirm danger';
    yes.textContent = 'Discard';
    yes.onclick = () => {
      confirmingDiscard = null;
      send({ t: 'discard', container: group.id });
    };

    const no = document.createElement('button');
    no.className = 'group-confirm';
    no.textContent = 'Keep it';
    no.onclick = () => {
      confirmingDiscard = null;
      renderPicker(lastGroups);
    };

    row.append(yes, no);
    return row;
  }

  const open = document.createElement('button');
  open.className = 'group-open';

  const name = document.createElement('span');
  name.className = 'group-name';
  name.textContent = group.name;
  open.append(name);

  const meta = document.createElement('span');
  meta.className = 'group-meta';
  meta.textContent = `${group.tabs.length} tab${group.tabs.length === 1 ? '' : 's'} · closed ${ago(
    group.closedAt,
  )}`;
  open.append(meta);

  const tabs = document.createElement('span');
  tabs.className = 'group-tabs';
  tabs.textContent = group.tabs.map((tab) => tab.label).join(' · ');
  tabs.title = group.tabs.map((tab) => `${tab.label} — ${tab.cwd}`).join('\n');
  open.append(tabs);

  open.onclick = () => send({ t: 'adopt', container: group.id });
  open.ondblclick = (event) => event.preventDefault();
  row.append(open);

  const rename = document.createElement('button');
  rename.className = 'group-icon';
  rename.textContent = '✎';
  rename.title = 'Rename this window';
  rename.onclick = () => startGroupRename(name, group);
  row.append(rename);

  const discard = document.createElement('button');
  discard.className = 'group-icon danger';
  discard.textContent = '×';
  discard.title = 'End the shells in this window';
  discard.onclick = () => {
    confirmingDiscard = group.id;
    renderPicker(lastGroups);
  };
  row.append(discard);

  return row;
}

function startGroupRename(holder, group) {
  const input = document.createElement('input');
  input.className = 'group-rename';
  input.value = group.name;
  holder.replaceChildren(input);
  input.focus();
  input.select();

  pickerEditing = true;
  let done = false;
  const commit = (save) => {
    if (done) return;
    done = true;
    pickerEditing = false;
    if (save) send({ t: 'renamewindow', container: group.id, name: input.value });
    renderPicker(lastGroups);
  };

  input.onclick = (event) => event.stopPropagation();
  input.onkeydown = (event) => {
    event.stopPropagation();
    if (event.key === 'Enter') commit(true);
    if (event.key === 'Escape') commit(false);
  };
  input.onblur = () => commit(true);
}

/** The answer that is not one of the listed windows: start a fresh one. */
function chooseNewWindow() {
  if (!picking) return;
  settle();
  newTab();
}

// Escape is the way out of any list, and out of this one means the plain
// answer: a new window.
window.addEventListener('keydown', (event) => {
  if (picking && event.key === 'Escape') chooseNewWindow();
});

/*
 * An empty window is never left standing.
 *
 * The picker is drawn from a message the daemon sends on connection. If one
 * never comes — an older daemon that has not been reloaded yet, a list that
 * emptied while the browser was starting — this window would sit there blank
 * with no way to do anything at all. So it waits a moment and then does what it
 * would have done without a picker: opens a shell.
 */
function pickerFallback() {
  if (!picking || !el.picker.hidden) return;
  // Not connected yet is not the same as never coming: keep waiting, because
  // the daemon being slow is not a reason to open a shell nobody asked for.
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    setTimeout(pickerFallback, 1000);
    return;
  }
  chooseNewWindow();
}

setTimeout(pickerFallback, 4000);

/**
 * Write recovered scrollback with the pane's answering machine switched off.
 *
 * The flag is cleared when xterm says it has finished parsing, and again on a
 * timer in case that callback never comes: a pane that stayed muted would look
 * exactly like a shell that had stopped taking input.
 */
function replay(pane, scrollback) {
  pane.replaying = true;
  const done = () => {
    pane.replaying = false;
  };
  pane.term.write(scrollback, done);
  setTimeout(done, 2000);
}

function attach(id) {
  const pane = panes.get(id);
  if (!pane || pane.attached) return;
  safeFit(pane);
  send({ t: 'attach', id, cols: pane.term.cols, rows: pane.term.rows });
}

function closeTab(id) {
  send({ t: 'close', id });
  removePane(id);
  sessions.delete(id);
  renderTabs();
}

/**
 * Close every tab but one — the quick way back to a single window, and with the
 * survivor closed too, the way to clear the lot.
 */
function closeOthers(keepId) {
  if (!sessions.has(keepId)) return;
  // Make the survivor active first. Closing the tab being watched sends
  // removePane hunting for a replacement, and every candidate here is itself
  // about to be closed.
  activate(keepId);
  for (const id of [...sessions.keys()]) {
    if (id !== keepId) closeTab(id);
  }
}

// --------------------------------------------------------------------- panes

function ensurePane(id) {
  let pane = panes.get(id);
  if (pane) return pane;

  const root = document.createElement('div');
  root.className = 'pane';
  // Which tab a file dropped on this pane belongs to; see dropTargetFor.
  root.dataset.id = id;

  const termEl = document.createElement('div');
  termEl.className = 'term';

  root.append(termEl);
  el.panes.append(root);

  const term = new Terminal({
    fontFamily: FONT_FAMILY,
    fontSize,
    theme: THEME,
    cursorBlink: true,
    scrollback: 10000,
    allowProposedApi: true,
    macOptionIsMeta: false,
    // 1 disables xterm's contrast adjustment, which is not a safety net so much
    // as a bleach: any foreground short of the ratio gets stepped 10% toward
    // white until it clears, so white-on-blue statuslines, fzf highlights and
    // diff markers all arrive as plain white. At 4.5 it also pastelled half
    // this palette outright — #aa0000 rendered as #cf6a6a. A terminal shows the
    // colour it was handed; ANSI black being invisible on a black background is
    // true here exactly as it is in xfce4-terminal.
    minimumContrastRatio: 1,
  });

  const fit = new FitAddon();
  term.loadAddon(fit);
  // Clicking a link is a job for the browser you actually use, in a tab
  // alongside everything else you have open — which is what every other
  // terminal does. Left to itself the addon calls window.open, and in a Chrome
  // app window that means a bare new window of clio's own private profile:
  // signed in to nothing, remembering nothing, and not where you were reading.
  // The daemon hands it to the desktop instead.
  term.loadAddon(new WebLinksAddon((event, uri) => send({ t: 'openurl', url: uri })));
  term.open(termEl);

  // Replayed history is not typing, and must never be answered as though it
  // were. Scrollback is a recording of everything a program wrote, questions
  // included: `\x1b]11;?` asking what colour the background is, `\x1b[c` asking
  // what kind of terminal this is. Replaying it asks them again, xterm answers
  // as it should, and the answers land in the shell that is there *now* — which
  // is how `11;rgb:0000/0000/0000` ends up typed at a bash prompt.
  term.onData((data) => {
    if (panes.get(id)?.replaying) return;
    send({ t: 'input', id, data });
  });
  term.onResize(({ cols, rows }) => send({ t: 'resize', id, cols, rows }));
  // Kept outside `sessions`, which is wholesale replaced on every server
  // broadcast and would drop the title a couple of seconds after it arrived.
  term.onTitleChange((title) => {
    termTitles.set(id, title);
    renderTabs();
  });

  // Our own shortcuts must win before xterm turns them into control bytes.
  term.attachCustomKeyEventHandler((event) => !isShortcut(event));

  termEl.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    openContextMenu(event.clientX, event.clientY, id);
  });

  pane = { id, root, termEl, term, fit, attached: false, replaying: false };
  panes.set(id, pane);
  return pane;
}

function removePane(id) {
  const pane = panes.get(id);
  if (!pane) return;
  pane.term.dispose();
  pane.root.remove();
  panes.delete(id);
  termTitles.delete(id);

  if (activeId === id) {
    activeId = null;
    const next = order.find((other) => other !== id && sessions.has(other));
    if (next) activate(next);
  }
}

function activate(id) {
  if (!id || !sessions.has(id)) return;
  activeId = id;
  ensurePane(id);

  for (const [paneId, pane] of panes) {
    pane.root.classList.toggle('active', paneId === id);
  }

  const pane = panes.get(id);
  attach(id);
  // Tells the daemon which tab is being watched, so output anywhere else counts
  // as unseen activity.
  send({ t: 'focus', id });
  resizeActive();
  pane.term.focus();

  renderTabs();
  refreshTitle();
}

/**
 * A named window says so in its title, which is all the desktop's window list
 * and alt-tab have to go on when six of these are open at once.
 */
function refreshTitle() {
  if (picking) {
    document.title = 'clio — open a window';
    return;
  }
  const where = windowName ? `${windowName} · clio` : 'clio';
  document.title = activeId ? `${tabLabel(sessions.get(activeId))} — ${where}` : where;
}

/** Resize a pane to its container, ignoring proposals from an unlaid-out pane. */
function safeFit(pane) {
  if (!pane) return;
  let dims;
  try {
    dims = pane.fit.proposeDimensions();
  } catch {
    return;
  }
  if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return;
  if (dims.cols < MIN_COLS || dims.rows < MIN_ROWS) return;
  if (dims.cols === pane.term.cols && dims.rows === pane.term.rows) return;
  pane.term.resize(dims.cols, dims.rows);
}

function resizeActive() {
  const pane = panes.get(activeId);
  if (!pane) return;
  // Two frames: one for the pane becoming visible, one for layout to settle.
  requestAnimationFrame(() => requestAnimationFrame(() => safeFit(pane)));
}

/** Rough cell grid for sizing a session we have not rendered yet. */
function measure() {
  const pane = panes.get(activeId);
  if (pane) return { cols: pane.term.cols, rows: pane.term.rows };
  return { cols: 80, rows: 24 };
}

// ---------------------------------------------------------------------- tabs

/*
 * Programs announce what they are doing by setting the terminal title (OSC 0/2)
 * — Claude Code puts the name of the current job there. That is far more useful
 * than the process name, so it outranks the command.
 *
 * The exception is the title a shell sets for itself. Bash's stock
 * PROMPT_COMMAND emits "user@host:/path", which says nothing the tab does not
 * already show, so it is ignored in favour of the directory.
 */
function isShellDefaultTitle(title) {
  return /^[^@\s]+@[^:\s]+:/.test(title.trim());
}

/*
 * What a tab is called, in the order the answers are worth having:
 *
 *   1. the name somebody typed for it, which nothing overrules
 *   2. what its extension says it is holding — the host, for an ssh session
 *   3. what a program running in it says it is doing
 *   4. the command that is running
 *   5. the directory it is in
 *
 * The extension goes above the announced title, and it has to. A title arrives
 * from whatever last set one, and once a tab has ssh'd away that is usually the
 * shell you left behind on this machine — a prompt that announced `~/core` on
 * the way past and has said nothing since. It is not "user@host:" shaped, so
 * the rule above does not catch it, and it goes on describing a directory on
 * the wrong computer for as long as the session lasts. The far end mostly
 * announces nothing at all, and when it does it is its own `user@host:` form,
 * which is thrown away here anyway. So: a tab that is on a host is named after
 * the host, and stays named after it.
 */
function tabLabel(meta) {
  if (!meta) return 'shell';
  if (meta.title) return meta.title;

  if (meta.ext?.title) return meta.ext.title;

  // The pane's own copy of the announced title is the live one — xterm parses
  // the sequence as it arrives — but only a tab somebody has opened has a pane
  // to parse it, and after a restore that is one tab out of thirteen. The daemon
  // reads the same titles out of the same stream for every tab, a couple of
  // seconds behind, and that is what the rest of the row is named after.
  const pane = panes.get(meta.id);
  const announced = (pane?.attached && termTitles.get(meta.id)) || meta.termTitle;
  if (announced && !isShellDefaultTitle(announced)) return announced;

  if (meta.command) return basename(meta.command.split(/\s+/)[0]);
  if (meta.cwd && HOME && meta.cwd === HOME) return '~';
  const dir = basename(meta.cwd || '');
  return dir || '~';
}

function basename(path) {
  const parts = String(path).split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Rebuild the tab strip, but only when it would actually look different.
 *
 * Every rebuild throws away the elements the mouse is currently interacting
 * with. If that happens between a mousedown and its mouseup the browser never
 * fires the click at all, so a button silently does nothing. Session updates
 * arrive every couple of seconds, so re-rendering unconditionally puts a
 * permanent race under the user's cursor.
 */
function renderTabs(force = false) {
  if (renaming && !force) return;

  const signature = JSON.stringify(
    order.map((id) => {
      const meta = sessions.get(id);
      return meta
        ? [id, tabLabel(meta), meta.status, meta.unseenOutput, meta.waiting, id === activeId]
        : null;
    }),
  );
  if (!force && signature === lastTabsSignature) return;
  lastTabsSignature = signature;

  el.tabs.replaceChildren();

  for (const id of order) {
    const meta = sessions.get(id);
    if (!meta) continue;

    const tab = document.createElement('div');
    tab.className =
      'tab' +
      (id === activeId ? ' active' : '') +
      (meta.unseenOutput ? ' activity' : '') +
      // Something in there has stopped and is waiting to be answered. Never the
      // tab that is open: the daemon will not flag one anybody is looking at,
      // and this says so again here, so that clicking a flashing tab stops it
      // on the spot rather than when the next broadcast comes round.
      (meta.waiting && id !== activeId ? ' waiting' : '');
    tab.draggable = true;
    tab.dataset.id = id;
    // The label is often elided, so keep the full text reachable on hover.
    tab.title = [tabLabel(meta), meta.cwd].filter(Boolean).join('\n');

    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = tabLabel(meta);
    tab.append(title);

    const close = document.createElement('span');
    close.className = 'tab-close';
    close.textContent = '×';
    close.title = 'Close tab';
    // Keep mousedown away from the tab too: activating would re-render the
    // strip out from under this very element and swallow the click.
    close.onmousedown = (event) => event.stopPropagation();
    close.onclick = (event) => {
      event.stopPropagation();
      closeTab(id);
    };
    tab.append(close);

    tab.onmousedown = (event) => {
      if (event.button === 0) activate(id);
      if (event.button === 1) {
        event.preventDefault();
        closeTab(id);
      }
    };
    tab.ondblclick = (event) => {
      if (event.target === close) return;
      startRename(tab, id);
    };
    tab.oncontextmenu = (event) => {
      event.preventDefault();
      openContextMenu(event.clientX, event.clientY, id);
    };

    wireDrag(tab, id);
    el.tabs.append(tab);
  }

  // Sits immediately after the last tab and scrolls with them, rather than
  // being pinned to the far edge of the window.
  el.tabs.append(el.newtab);
}

function startRename(tab, id) {
  const holder = tab.querySelector('.tab-title');
  const meta = sessions.get(id);
  const input = document.createElement('input');
  input.value = meta?.title || tabLabel(meta);
  holder.replaceChildren(input);
  input.focus();
  input.select();

  // Hold off re-renders; one arriving mid-edit would delete the input.
  renaming = true;

  let done = false;
  const commit = (save) => {
    if (done) return;
    done = true;
    renaming = false;
    if (save) send({ t: 'rename', id, title: input.value });
    renderTabs(true);
  };

  input.onkeydown = (event) => {
    event.stopPropagation();
    if (event.key === 'Enter') commit(true);
    if (event.key === 'Escape') commit(false);
  };
  input.onblur = () => commit(true);
}

// ----------------------------------------------------------- dragging tabs

/*
 * A tab is dragged to move it, and there are three places it can go: along this
 * window's strip to reorder it, onto another clio window's strip to hand it
 * over, and out of every window on the desktop to pull it into one of its own.
 * All three are what a Chrome tab does, and none of it had to be invented —
 * something that looks like a tab should move like one.
 *
 * What makes the last two possible is that a tab was never the window's to
 * begin with. The shell is in the daemon and the page is a viewer, so handing
 * one over is a change of which page draws it: no process is signalled, nothing
 * is re-opened, and the program running in the tab is not told anything at all.
 *
 * Two windows are two pages that cannot see each other. What crosses between
 * them is what the browser carries in the drag, and what the daemon does about
 * it afterwards — the daemon being the only thing both of them are talking to.
 * The drag carries the tab's id and the window it came from under a type of
 * clio's own, and deliberately not as text/plain: a terminal is entitled to
 * paste anything dropped on it as text, and a tab is not text.
 */
const TAB_MIME = 'application/x-clio-tab';

/** The tab this window is dragging, while it is dragging one. */
let dragId = null;

/** A tab dragged in from elsewhere, waiting for the daemon to make it ours. */
let adopting = null;

/**
 * How long a tab let go of outside this window waits before becoming a window
 * of its own.
 *
 * It may have landed on another clio window's strip — a window this page cannot
 * see, cannot ask, and gets no event from. The only sign is the tab leaving our
 * own list a moment later, when the daemon says who has it now. So that round
 * trip is given this long before "outside" is taken to mean "nowhere".
 */
const POP_WAIT_MS = 300;

/** True when a drag is carrying one of our tabs rather than something to type. */
function carriesTab(dt) {
  return !!dt && [...dt.types].includes(TAB_MIME);
}

function wireDrag(tab, id) {
  tab.ondragstart = (event) => {
    dragId = id;
    tab.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
    // Which tab, and which window it is leaving. Nothing more is needed or
    // wanted: whoever takes it asks the daemon for it by id, and the daemon is
    // the one holding the shell.
    event.dataTransfer.setData(TAB_MIME, JSON.stringify({ id, container: containerId }));
  };

  tab.ondragend = (event) => {
    const dragged = dragId;
    dragId = null;
    // Not left to the re-render: nothing about the row has changed when a drag
    // is abandoned, and renderTabs would rightly decide there was nothing to
    // draw — leaving the tab faded out for as long as the window stayed open.
    tab.classList.remove('dragging');
    clearDropMarkers();
    renderTabs();
    if (!dragged) return;

    // Let go inside this window is a drag that came to nothing — a tab dropped
    // on a terminal is not a request to move it, and the row above is the one
    // place that acts on one.
    if (within(event.clientX, event.clientY)) return;
    popOut(dragged, { x: event.screenX, y: event.screenY });
  };
}

/**
 * When Escape was last seen, so a drag it cancelled is not acted on.
 *
 * The keydown that cancels a drag never reaches the page — the browser's drag
 * session swallows it — but the keyup arrives a moment after dragend, and it is
 * the only thing that tells an abandoned drag from a deliberate one. dropEffect
 * does not: it reports what the last thing the pointer crossed made of the drag,
 * so a tab let go over the desktop reads as 'none' if it went straight there and
 * 'move' if it passed over another window's strip on the way, and an abandoned
 * drag reads the same as the first of those. Measured, not assumed.
 */
let escapedAt = 0;

window.addEventListener('keyup', (event) => {
  if (event.key === 'Escape') escapedAt = Date.now();
});

/** Whether a point is inside this window's own page. */
function within(x, y) {
  // A browser that will not say lands here, and it must read as "inside": doing
  // nothing is the right answer to a drag nobody can account for.
  if (!Number.isFinite(x) || !Number.isFinite(y)) return true;
  return x >= 0 && y >= 0 && x <= window.innerWidth && y <= window.innerHeight;
}

/**
 * A tab let go of somewhere this window is not.
 *
 * Another clio window may have taken it, and the only way that shows up here is
 * the tab going quiet and leaving our list. So the answer waits: a tab still
 * ours after the wait was dropped on nothing, and a tab dropped on nothing was
 * pulled out to stand on its own.
 */
function popOut(id, at) {
  // The only tab in the window: it *is* a window of its own. Pulling it out
  // would move it one frame to the right and leave an empty one behind.
  if (order.length < 2) return;

  const letGoAt = Date.now();
  setTimeout(() => {
    if (escapedAt >= letGoAt) return; // abandoned rather than let go
    if (!sessions.has(id)) return; // somebody else has it now
    send({ t: 'poptab', id, geometry: popGeometry(at) });
  }, POP_WAIT_MS);
}

/**
 * Where a window pulled out of this one opens: under the cursor that pulled it,
 * at the size of the window it came from, which is what dropping a Chrome tab
 * on the desktop gives you.
 *
 * The offset is what puts the strip near the pointer rather than the top-left
 * corner, so the tab lands roughly where it was let go.
 */
function popGeometry(at) {
  const now = currentGeometry();
  // Not past the top left of the desktop, which is not always zero: a monitor
  // above or left of the primary one has negative coordinates, and a tab let go
  // over there belongs over there rather than pulled back onto the primary.
  const left = Number.isFinite(window.screen?.availLeft) ? window.screen.availLeft : 0;
  const top = Number.isFinite(window.screen?.availTop) ? window.screen.availTop : 0;
  return {
    x: Math.max(left, Math.round(at.x - 60)),
    y: Math.max(top, Math.round(at.y - 16)),
    width: now?.width || window.outerWidth,
    height: now?.height || window.outerHeight,
  };
}

/**
 * Where in the row a tab held over the strip would land: which tab it would sit
 * against, and on which side.
 *
 * Past the last tab — over the +, or the empty stretch after it — means the end
 * of the row, which is where a tab dropped on a window with room to spare
 * should go.
 */
function insertionAt(clientX) {
  const tabs = [...el.tabs.querySelectorAll('.tab[data-id]')];
  for (const tab of tabs) {
    const rect = tab.getBoundingClientRect();
    if (clientX < rect.left + rect.width / 2) return { tab, before: true };
  }
  const last = tabs[tabs.length - 1];
  return last ? { tab: last, before: false } : null;
}

/** This window's row of tabs with `id` moved — or added — at that spot. */
function orderWith(id, spot) {
  const next = order.filter((other) => other !== id);
  const index = next.indexOf(spot.tab.dataset.id);
  if (index === -1) return [...next, id];
  next.splice(spot.before ? index : index + 1, 0, id);
  return next;
}

/**
 * The strip is the target, rather than each tab in it.
 *
 * A tab arriving from another window is a tab this page has never heard of, and
 * the gaps between tabs, the + and the empty stretch beyond it are all places a
 * person will let go of one. One handler on the row covers the lot, and works
 * out what it was over from where the pointer is.
 */
function wireStrip() {
  el.tabs.addEventListener('dragover', (event) => {
    if (!carriesTab(event.dataTransfer)) return;
    const spot = insertionAt(event.clientX);
    // Its own place in the row: there is nothing to show and nothing to do.
    if (!spot || spot.tab.dataset.id === dragId) {
      clearDropMarkers();
      return;
    }
    // Without this the drop is refused, and a tab dragged from another window
    // would spring back for no visible reason.
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    clearDropMarkers();
    // A tab out of another window: the row itself says it will take one, since
    // nothing else on screen has told the person so — the tab they are dragging
    // is in a window that cannot draw anything here. One of our own moving along
    // the row needs no such announcement, and the marker is enough.
    if (!dragId) el.tabs.classList.add('taking');
    spot.tab.classList.add(spot.before ? 'drop-before' : 'drop-after');
  });

  // Crossing from one tab to the next fires this the whole way along the strip,
  // so only leaving the row itself counts.
  el.tabs.addEventListener('dragleave', (event) => {
    if (el.tabs.contains(event.relatedTarget)) return;
    clearDropMarkers();
  });

  el.tabs.addEventListener('drop', (event) => {
    if (!carriesTab(event.dataTransfer)) return;
    event.preventDefault();
    const spot = insertionAt(event.clientX);
    clearDropMarkers();

    let dropped = null;
    try {
      dropped = JSON.parse(event.dataTransfer.getData(TAB_MIME));
    } catch {
      /* not something we put there */
    }
    // Its own place in the row, which is not a move. dragover refuses the
    // position so the drop should never arrive, and it is cheap to be sure.
    if (!dropped?.id || !spot || spot.tab.dataset.id === dropped.id) return;

    const next = orderWith(dropped.id, spot);

    // One of our own, moved along the row.
    if (dropped.container === containerId) {
      if (!sessions.has(dropped.id)) return;
      order = next;
      renderTabs(true);
      send({ t: 'reorder', ids: order });
      return;
    }

    /*
     * A tab out of another window. Nothing is drawn yet — this page has no
     * shell for it, no scrollback and no claim to it — so it asks the daemon,
     * which owns the tab, and the tab appears when the daemon says it is ours.
     */
    adopting = dropped.id;
    send({ t: 'adopttab', id: dropped.id, ids: next });
  });
}

function clearDropMarkers() {
  el.tabs.classList.remove('taking');
  for (const tab of el.tabs.children) {
    tab.classList.remove('drop-before', 'drop-after');
  }
}

// ------------------------------------------------------------- context menu

/*
 * Deliberately fixed for now: copy, paste and tab management, nothing more.
 * Everything the configurable menu will need already routes through here —
 * buildMenu() is the single place entries get assembled, so a user config file
 * becomes a matter of generating this array from disk instead of hard-coding it.
 */
function buildMenu(id) {
  const pane = panes.get(id);
  const selection = pane ? pane.term.getSelection() : '';
  const others = order.filter((other) => other !== id && sessions.has(other)).length;

  const entries = [
    {
      label: 'Copy',
      key: 'Ctrl+Shift+C',
      disabled: !selection,
      run: () => copySelection(id),
    },
    { label: 'Paste', key: 'Ctrl+Shift+V', run: () => paste(id) },
    { sep: true },
    { label: 'New Tab', key: 'Ctrl+Shift+T', run: newTab },
    {
      label: 'Rename Tab',
      run: () => {
        const tab = el.tabs.querySelector(`[data-id="${id}"]`);
        if (tab) startRename(tab, id);
      },
    },
  ];

  entries.push(
    { label: 'Close Tab', run: () => closeTab(id) },
    {
      label: others === 1 ? 'Close Other Tab' : `Close Other Tabs (${others})`,
      disabled: !others,
      run: () => confirmCloseOthers(id, others),
    },
    { sep: true },
    // Closing this window keeps its tabs under a name, and this is where that
    // name is chosen rather than guessed from what happens to be in the first
    // tab. Naming it before it is put away is the difference between finding it
    // again and reading a list of directories.
    { label: 'Name This Window…', run: renameWindowMenu },
  );

  return entries;
}

/*
 * Closing the others is the one entry here that cannot be undone — each of
 * those tabs is a running process, and clio kills them for good — so it asks
 * first, in its own menu. A browser confirm() would be the only native dialog
 * in the app, and it would land on a different part of the screen than the
 * click that summoned it.
 */
function confirmCloseOthers(id, count) {
  renderMenu([
    {
      label: `Close ${count} other tab${count === 1 ? '' : 's'}?`,
      danger: true,
      run: () => closeOthers(id),
    },
    { label: 'Keep them', run: () => {} },
  ]);
}

/**
 * Name this window, in the menu it was asked for from.
 *
 * A name given here outlives the window: it is what the tabs are put away under
 * when it is closed, and what the picker lists them by. Empty clears it, and
 * the automatic name — whatever the first tab is called — takes over again.
 */
function renameWindowMenu() {
  renderMenu([
    {
      input: true,
      value: windowName || '',
      placeholder: 'Name this window',
      run: (value) => send({ t: 'renamewindow', name: value }),
    },
  ]);
}

/** Where the menu was summoned, so a follow-up menu opens in the same place. */
let menuAt = { x: 0, y: 0 };

function openContextMenu(x, y, id) {
  menuAt = { x, y };
  renderMenu(buildMenu(id));
}

function renderMenu(entries) {
  const menu = el.ctxmenu;
  menu.replaceChildren();

  let focusMe = null;

  for (const entry of entries) {
    if (entry.sep) {
      const sep = document.createElement('div');
      sep.className = 'sep';
      menu.append(sep);
      continue;
    }

    // A menu item that is typed into rather than chosen. The only alternative
    // is prompt(), which is a dialog the browser draws in the middle of the
    // screen with clio's URL above it.
    if (entry.input) {
      const field = document.createElement('div');
      field.className = 'item field';
      const input = document.createElement('input');
      input.value = entry.value || '';
      input.placeholder = entry.placeholder || '';
      input.onkeydown = (event) => {
        event.stopPropagation();
        if (event.key === 'Enter') {
          closeContextMenu();
          entry.run(input.value);
          panes.get(activeId)?.term.focus();
        }
        if (event.key === 'Escape') {
          closeContextMenu();
          panes.get(activeId)?.term.focus();
        }
      };
      field.append(input);
      menu.append(field);
      focusMe = input;
      continue;
    }

    const item = document.createElement('div');
    item.className =
      'item' + (entry.disabled ? ' disabled' : '') + (entry.danger ? ' danger' : '');

    const label = document.createElement('span');
    // A tick in a fixed-width gutter rather than a checkbox: an empty box in a
    // menu reads as something to fill in, and the space has to be held whether
    // the tick is there or not or the label shifts as it is toggled.
    if ('checked' in entry) {
      const tick = document.createElement('span');
      tick.className = 'tick';
      tick.textContent = entry.checked ? '✓' : '';
      label.append(tick);
    }
    label.append(entry.label);
    item.append(label);

    if (entry.key) {
      const key = document.createElement('span');
      key.className = 'key';
      key.textContent = entry.key;
      item.append(key);
    }

    if (!entry.disabled) {
      item.onclick = () => {
        closeContextMenu();
        entry.run();
      };
    }
    menu.append(item);
  }

  menu.hidden = false;
  // Place first, then pull back inside the viewport now that it has a size.
  menu.style.left = `${menuAt.x}px`;
  menu.style.top = `${menuAt.y}px`;
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 4}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 4}px`;

  // After placing, or the caret lands somewhere the menu is not yet.
  focusMe?.focus();
  focusMe?.select();
}

function closeContextMenu() {
  el.ctxmenu.hidden = true;
}

window.addEventListener('mousedown', (event) => {
  if (!el.ctxmenu.hidden && !el.ctxmenu.contains(event.target)) closeContextMenu();
});
window.addEventListener('blur', closeContextMenu);

// ----------------------------------------------------------------- clipboard

async function copySelection(id) {
  const pane = panes.get(id);
  const text = pane?.term.getSelection();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    showStatus('Clipboard write was blocked by the browser.', 3000);
  }
}

async function paste(id) {
  try {
    const text = await navigator.clipboard.readText();
    if (text) send({ t: 'input', id, data: text });
  } catch {
    showStatus('Clipboard read was blocked — allow clipboard access for this window.', 4000);
  }
}

// ------------------------------------------------------------------ dropping

/*
 * A file dragged into a window.
 *
 * Dropping an image on a terminal and having its path typed is how you put one
 * in front of a program running there, and every other terminal on the desktop
 * does it. A page cannot: Chrome hands over a dropped file's name, size,
 * modification time and bytes, and nothing whatever about where it came from.
 * So the window reports what it was given and the daemon works out a path —
 * the file's own if it can find it, a copy's if it cannot. src/daemon/drops.js
 * is the other half of this.
 *
 * Anything dropped that is not a file — a URL out of a browser, selected text —
 * is pasted as it stands, which is also what dropping it anywhere else does.
 */

/** Drops the daemon is still working on, keyed by the token it will answer with. */
const dropsInFlight = new Map();

let dropSeq = 0;
const dropToken = () => `d${Date.now().toString(36)}-${dropSeq++}`;

/** True when a drag is carrying something a terminal can take. */
function droppable(dt) {
  if (!dt) return false;
  const types = [...dt.types];
  // A tab from another clio window comes through here too — it is a drag from
  // outside this page like any other. It is not something to type: it belongs
  // to the strip, and the strip is the only thing that takes it.
  if (types.includes(TAB_MIME)) return false;
  return types.includes('Files') || types.includes('text/uri-list') || types.includes('text/plain');
}

/** Which tab a drop lands in: the pane under the pointer, or the tab it is over. */
function dropTargetFor(event) {
  const node = event.target instanceof Element ? event.target : null;
  const pane = node?.closest('.pane[data-id]');
  if (pane && sessions.has(pane.dataset.id)) return { id: pane.dataset.id, node: pane };

  const tab = node?.closest('#tabs [data-id]');
  if (tab && sessions.has(tab.dataset.id)) return { id: tab.dataset.id, node: tab };

  if (activeId && panes.has(activeId)) return { id: activeId, node: panes.get(activeId).root };
  return null;
}

/** The tab or pane about to take the drop, outlined while the mouse is held. */
let dropMark = null;

function markDrop(node) {
  if (dropMark === node) return;
  dropMark?.classList.remove('dropping');
  dropMark = node || null;
  dropMark?.classList.add('dropping');
}

/*
 * What was dropped, as files.
 *
 * Read out here and now, because a DataTransfer only lives for the length of
 * the event: reaching into it afterwards comes back empty.
 */
function droppedFiles(dt) {
  const out = [];
  const items = dt.items;
  for (let i = 0; items && i < items.length; i++) {
    const item = items[i];
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (!file) continue;
    // A folder arrives as a file carrying the directory's own size, and only
    // the entry says which it is. The daemon has to know: a folder has no bytes
    // to copy, so either it is found on disk or the drop has nothing to type.
    const entry = item.webkitGetAsEntry?.();
    out.push({ file, dir: !!entry?.isDirectory });
  }
  if (!out.length) {
    for (let i = 0; dt.files && i < dt.files.length; i++) out.push({ file: dt.files[i], dir: false });
  }
  // Dropping a photo album on a terminal is a slip, not a request for two
  // hundred paths.
  return out.slice(0, 20);
}

window.addEventListener('dragover', (event) => {
  if (dragId) return; // a tab being dragged along the tab bar is not a drop
  if (!droppable(event.dataTransfer)) return;
  // Without this the browser takes the drop itself, and a window whose entire
  // job is to stay where it is navigates away to the image somebody dropped.
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
  markDrop(dropTargetFor(event)?.node);
});

// Only when the pointer has left the window: crossing the elements inside a
// pane fires this the whole way across.
window.addEventListener('dragleave', (event) => {
  if (event.relatedTarget === null) markDrop(null);
});

window.addEventListener('drop', (event) => {
  markDrop(null);
  if (dragId) return;
  if (!droppable(event.dataTransfer)) return;
  event.preventDefault();

  const target = dropTargetFor(event);
  if (!target) {
    showStatus('Open a tab to drop that into.', 3000);
    return;
  }
  // Dropping on a tab means that tab — and it is brought to the front, because
  // text arriving in a tab nobody is looking at is how you end up typing it
  // twice.
  if (target.id !== activeId) activate(target.id);

  const files = droppedFiles(event.dataTransfer);
  if (!files.length) {
    pasteInto(target.id, event.dataTransfer.getData('text/uri-list') || event.dataTransfer.getData('text/plain'));
    return;
  }

  const token = dropToken();
  dropsInFlight.set(token, { id: target.id, files });
  send({
    t: 'drop',
    id: target.id,
    drop: token,
    files: files.map(({ file, dir }) => ({
      name: file.name,
      size: file.size,
      mtime: file.lastModified,
      dir,
    })),
  });
});

/** The bytes of one dropped file, as base64, which is what the daemon asked for. */
function readBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    // A data: URL rather than an ArrayBuffer turned into base64 here: encoding
    // tens of megabytes a character at a time in the page is slow at best and a
    // blown stack at worst, and this is the browser's own encoder.
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error || new Error('unreadable'));
    reader.readAsDataURL(file);
  });
}

/** Send up the files the daemon could not find, one at a time. */
async function sendDropBytes(token, need) {
  const pending = dropsInFlight.get(token);
  if (!pending) return;

  const names = need.map((index) => pending.files[index]?.file.name).filter(Boolean);
  if (names.length) showStatus(`Copying ${names.join(', ')} into clio…`, 15000);

  // In turn, not all at once: one file is in memory twice as it is, and a drop
  // of several large ones should not be in memory six times over.
  for (const index of need) {
    const entry = pending.files[index];
    if (!entry) {
      send({ t: 'dropdata', drop: token, index, error: 'that file is no longer there' });
      continue;
    }
    try {
      send({ t: 'dropdata', drop: token, index, data: await readBase64(entry.file) });
    } catch (err) {
      send({ t: 'dropdata', drop: token, index, error: String(err?.message || err) });
    }
  }
}

/*
 * Into the terminal as a paste, which is what it is. A program that asked for
 * bracketed paste is told this arrived in one piece, so a shell shows it as
 * something to look at rather than running the lines, and an editor does not
 * indent it as though it had been typed.
 */
function pasteInto(id, text) {
  const pane = panes.get(id);
  if (!pane || !text) return;
  pane.term.focus();
  pane.term.paste(text);
}

// ----------------------------------------------------------------- shortcuts

/** True when this event is a clio shortcut rather than terminal input. */
function isShortcut(event) {
  if (event.type !== 'keydown') return false;

  if (event.ctrlKey && event.shiftKey && !event.altKey) {
    return ['C', 'V', 'T', 'W', 'D', 'Tab'].includes(normalizeKey(event));
  }
  if (event.ctrlKey && !event.shiftKey && !event.altKey && event.key === 'Tab') return true;
  if (event.altKey && !event.ctrlKey && /^[1-9]$/.test(event.key)) return true;
  return false;
}

function normalizeKey(event) {
  if (event.key === 'Tab') return 'Tab';
  return event.key.length === 1 ? event.key.toUpperCase() : event.key;
}

window.addEventListener(
  'keydown',
  (event) => {
    if (!isShortcut(event)) return;
    event.preventDefault();
    event.stopPropagation();

    const key = normalizeKey(event);

    if (event.altKey) {
      const index = Number(event.key) - 1;
      if (order[index]) activate(order[index]);
      return;
    }

    if (key === 'Tab') {
      if (!order.length) return;
      const at = order.indexOf(activeId);
      const step = event.shiftKey ? -1 : 1;
      activate(order[(at + step + order.length) % order.length]);
      return;
    }

    switch (key) {
      case 'T':
        newTab();
        break;
      case 'W':
      case 'D':
        if (activeId) closeTab(activeId);
        break;
      case 'C':
        if (activeId) copySelection(activeId);
        break;
      case 'V':
        if (activeId) paste(activeId);
        break;
      default:
        break;
    }
  },
  true,
);

// ------------------------------------------------------------------ geometry

/*
 * A window comes back the size it was, on the monitor it was on.
 *
 * The daemon cannot do this from the outside. Chrome honours --window-size and
 * --window-position for the first window of its browser process and ignores them
 * for every one after it, so a morning that opens four windows gets one where it
 * asked and three stacked wherever the browser last had one. It is also the
 * wrong place to ask from: a monitor unplugged overnight, a window somebody
 * dragged — the page is the only thing that can read where it actually is.
 *
 * So the window places itself when it learns which tabs it is showing, and keeps
 * the daemon told from then on. On a poll, because a browser fires no event for a
 * window being moved, and 'resize' says nothing about which monitor you are on.
 */
const GEOMETRY_POLL_MS = 1000;
/** Differences smaller than this are not moves; a window manager may round. */
const GEOMETRY_SLACK = 2;

/** Which container this page has already put itself in place for. */
let placedFor = null;
/** The last position reported, so a still window is silent. */
let lastGeometry = null;

/**
 * Where this window is, in the coordinates that span every monitor — which is
 * what makes remembering the monitor come for free.
 */
function currentGeometry() {
  const now = {
    x: window.screenX,
    y: window.screenY,
    width: window.outerWidth,
    height: window.outerHeight,
  };
  if (!Object.values(now).every(Number.isFinite)) return null;
  return now.width > 0 && now.height > 0 ? now : null;
}

function moved(a, b) {
  return ['x', 'y', 'width', 'height'].some((key) => Math.abs(a[key] - b[key]) > GEOMETRY_SLACK);
}

/**
 * Put this window where its tabs were last seen.
 *
 * Only on the way in, and only when it is somewhere else already: a window that
 * the browser happened to place correctly is left alone rather than nudged.
 *
 * A maximised window was remembered as its maximised size and comes back as an
 * ordinary window of that size. It looks the same and is not the same, and there
 * is no way for a page to ask whether it was maximised — so that is as close as
 * this gets.
 */
function applyGeometry(saved) {
  const now = currentGeometry();
  if (!saved || !now || !moved(now, saved)) return;
  // A window on Wayland can neither move itself nor read where it is; both calls
  // are simply ignored there, which is the same as having nothing saved.
  //
  // Sized before it is moved, and the order matters: the browser will not put a
  // window where it would hang off the desktop, and it works that out from the
  // size the window is at the time. A window Chrome opened at its own default
  // and is about to be made smaller would be dragged back up the screen to make
  // room for a height it is not going to have — which is exactly the case of a
  // tab pulled out low on the screen into a window the size of the one it left.
  window.resizeTo(saved.width, saved.height);
  window.moveTo(saved.x, saved.y);
}

/** Tell the daemon where we are, when that changes. */
function reportGeometry() {
  // A window still on the picker has not become anything yet, and where an empty
  // frame happens to be is not worth remembering against the tabs it may adopt.
  if (picking) return;
  const now = currentGeometry();
  if (!now || (lastGeometry && !moved(lastGeometry, now))) return;
  lastGeometry = now;
  // Deliberately not through send(): this is chatter rather than something
  // somebody clicked, and a window whose daemon is down has been told so by
  // everything else already. It must not raise a banner of its own.
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ t: 'geometry', ...now }));
  }
}

// -------------------------------------------------------------------- status

/** Terminal state: this window will never work again, so say so plainly. */
function showDeadScreen(command = 'clio') {
  hideStatus();
  const screen = document.getElementById('deadscreen');
  if (!screen.hidden) return;

  screen.replaceChildren();
  const card = document.createElement('div');
  card.className = 'card';

  const heading = document.createElement('h1');
  heading.textContent = 'This window has lost its place';
  card.append(heading);

  const body = document.createElement('p');
  body.textContent =
    'The clio daemon is running but no longer recognises this window, so nothing here will respond. ' +
    'Your shells are still alive — open a fresh window to get them back:';
  card.append(body);

  const cmd = document.createElement('code');
  cmd.textContent = command;
  card.append(cmd);

  screen.append(card);
  screen.hidden = false;
}

let statusTimer = null;

function showStatus(text, timeout = 0) {
  el.status.textContent = text;
  el.status.hidden = false;
  clearTimeout(statusTimer);
  if (timeout) statusTimer = setTimeout(hideStatus, timeout);
}

function hideStatus() {
  el.status.hidden = true;
}

// ---------------------------------------------------------------------- boot

wireStrip();

el.newtab.onclick = newTab;
el.newwindow.onclick = () => {
  newWindow();
  panes.get(activeId)?.term.focus();
};
// Hand focus straight back, so adjusting the size does not leave you typing
// into a button instead of your shell.
el.fontUp.onclick = () => {
  stepUp();
  panes.get(activeId)?.term.focus();
};
el.fontDown.onclick = () => {
  stepDown();
  panes.get(activeId)?.term.focus();
};
updateFontButtons();

window.addEventListener('resize', resizeActive);
window.addEventListener('focus', () => panes.get(activeId)?.term.focus());

/*
 * The window has the focus and nothing inside it does: hand it back to the shell.
 *
 * A mousedown puts the focus on the nearest thing above it that can hold it, and
 * where there is nothing it puts it nowhere: off the terminal's textarea and onto
 * the page body. Every control in the tab row hands it straight back by name.
 * What has no control to hand it back are the pixels that belong to none of them
 * — the padding around the grid, and the sliver of it directly under the tab row,
 * where a click aimed at the tab that is already open lands when it goes a pixel
 * low. A rename ends the same way: the input box leaves the strip and takes the
 * focus with it. Nothing looks any different afterwards — same tab, same window,
 * cursor still sitting there — and every key typed into it is dropped without a
 * sound. The only ways out are a click in the middle of the terminal or Alt+1,
 * neither of which is something anybody should have to know.
 *
 * Only while the page still has the focus. The same event fires when the whole
 * window loses it, and taking the focus back there would be clio snatching at a
 * keyboard that has gone to another window.
 */
document.addEventListener('focusout', (event) => {
  // Somewhere on purpose — a button, a rename box, the picker's name field.
  if (event.relatedTarget) return;
  if (!document.hasFocus()) return;
  // After the click that did it has finished being handled, so that a click
  // which hands the focus on itself — a tab, the +, the font arrows — is left
  // to do exactly that.
  setTimeout(() => {
    if (!document.hasFocus() || document.activeElement !== document.body) return;
    panes.get(activeId)?.term.focus();
  }, 0);
});

setInterval(reportGeometry, GEOMETRY_POLL_MS);

connect();
