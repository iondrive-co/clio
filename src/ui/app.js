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

// ------------------------------------------------------------- closing guard

/*
 * Closing a window ends every shell in it. That is what closing a terminal
 * window has always meant, and the tabs do not come back — the daemon is there
 * so that a *daemon* going down cannot take your shells with it, not so that a
 * window you closed can be undone. Worth a question, then, and worth being able
 * to turn the question off.
 *
 * Kept beside the font size in this profile's storage, so the answer holds for
 * every clio window rather than for whichever one it was given in.
 */
const WARN_KEY = 'clio.warnOnClose';

function loadWarnOnClose() {
  try {
    return localStorage.getItem(WARN_KEY) !== 'off';
  } catch {
    return true;
  }
}

let warnOnClose = loadWarnOnClose();

function setWarnOnClose(next) {
  warnOnClose = next;
  try {
    localStorage.setItem(WARN_KEY, next ? 'on' : 'off');
  } catch {
    /* the setting simply will not persist */
  }
}

/*
 * The browser's own dialog is the only one available here: a window being torn
 * down cannot be drawn over, so anything of ours would go unseen. Chrome writes
 * the wording; all this decides is whether it appears at all.
 *
 * Nothing to ask about with no tabs left — closing the last one is what closes
 * the window — nor when this window has already been disowned and its shells
 * belong to somebody else.
 */
window.addEventListener('beforeunload', (event) => {
  if (!warnOnClose || disowned || !sessions.size) return;
  event.preventDefault();
  event.returnValue = ''; // older browsers want a value, not just a cancelled event
});

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
let ws = null;
let reconnectDelay = 250;
let HOME = '';
let bootstrapped = false;
// Set when the daemon is reachable but refuses this window's credentials.
let disowned = false;
let lastTabsSignature = null;
let renaming = false;

// ---------------------------------------------------------------- connection

// The token arrives in the URL, is exchanged for an HttpOnly cookie by the
// server, and is then scrubbed from the address bar. From here on the cookie
// authenticates us — including across reloads, which the URL could not do.
//
// The container id stays: it is this window's identity, and a reload that lost
// it would come back showing somebody else's tabs.
function rememberContainer() {
  const query = containerId ? `?c=${encodeURIComponent(containerId)}` : '';
  history.replaceState(null, '', `${location.pathname}${query}`);
}

if (new URLSearchParams(location.search).has('token')) rememberContainer();

function connect() {
  if (disowned) return;
  const query = containerId ? `?c=${encodeURIComponent(containerId)}` : '';
  ws = new WebSocket(`ws://${location.host}/${query}`);

  ws.onopen = () => {
    reconnectDelay = 250;
    disowned = false;
    hideStatus();
    // A reconnect means every pane's view is stale: drop what is on screen and
    // let the server replay authoritative scrollback.
    for (const pane of panes.values()) {
      pane.attached = false;
      pane.term.reset();
    }
    if (activeId) attach(activeId);
  };

  ws.onmessage = (event) => handle(JSON.parse(event.data));

  ws.onclose = (event) => {
    // 1012 is the daemon saying it is being replaced, not that it has gone: a
    // successor is already coming up with these shells still running. Backing
    // off would leave the window dark for seconds after it could have returned.
    if (event.code === 1012) reconnectDelay = 250;
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

/**
 * Say out loud when this window belongs to a sandbox.
 *
 * `clio dev` runs a second daemon with its own state, port and shells, and its
 * windows are pixel-identical to the real ones. The badge and the title are
 * what stop a command meant for a throwaway shell from landing in a real one.
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
      if (msg.container && msg.container !== containerId) {
        containerId = msg.container;
        rememberContainer();
      }
      setDev(msg.dev);
      syncSessions(msg.sessions, msg.home);
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
      if (msg.scrollback) pane.term.write(msg.scrollback);
      renderTabs();
      break;
    }

    case 'data': {
      const pane = panes.get(msg.id);
      if (pane) pane.term.write(msg.data);
      break;
    }

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
  if (!activeId || !sessions.has(activeId)) {
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

  term.onData((data) => send({ t: 'input', id, data }));
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

  pane = { id, root, termEl, term, fit, attached: false };
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
  document.title = `${tabLabel(sessions.get(id))} — clio`;
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

function tabLabel(meta) {
  if (!meta) return 'shell';
  if (meta.title) return meta.title;

  const announced = termTitles.get(meta.id);
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
        ? [id, tabLabel(meta), meta.status, meta.unseenOutput, id === activeId]
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
      (meta.unseenOutput ? ' activity' : '');
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

// -------------------------------------------------------------- drag reorder

let dragId = null;

function wireDrag(tab, id) {
  tab.ondragstart = (event) => {
    dragId = id;
    tab.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', id);
  };

  tab.ondragend = () => {
    dragId = null;
    clearDropMarkers();
    renderTabs();
  };

  tab.ondragover = (event) => {
    if (!dragId || dragId === id) return;
    event.preventDefault();
    const rect = tab.getBoundingClientRect();
    const after = event.clientX > rect.left + rect.width / 2;
    clearDropMarkers();
    tab.classList.add(after ? 'drop-after' : 'drop-before');
  };

  tab.ondragleave = () => tab.classList.remove('drop-before', 'drop-after');

  tab.ondrop = (event) => {
    event.preventDefault();
    if (!dragId || dragId === id) return;
    const rect = tab.getBoundingClientRect();
    const after = event.clientX > rect.left + rect.width / 2;

    const next = order.filter((other) => other !== dragId);
    const index = next.indexOf(id);
    next.splice(after ? index + 1 : index, 0, dragId);

    order = next;
    clearDropMarkers();
    renderTabs();
    send({ t: 'reorder', ids: order });
  };
}

function clearDropMarkers() {
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
    // Where the "and don't ask me again" of the close warning lives. A dialog
    // the browser draws cannot carry a checkbox of ours, so the checkbox is
    // here, one right-click from the window it is about.
    {
      label: 'Ask before closing a window',
      checked: warnOnClose,
      run: () => setWarnOnClose(!warnOnClose),
    },
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

/** Where the menu was summoned, so a follow-up menu opens in the same place. */
let menuAt = { x: 0, y: 0 };

function openContextMenu(x, y, id) {
  menuAt = { x, y };
  renderMenu(buildMenu(id));
}

function renderMenu(entries) {
  const menu = el.ctxmenu;
  menu.replaceChildren();

  for (const entry of entries) {
    if (entry.sep) {
      const sep = document.createElement('div');
      sep.className = 'sep';
      menu.append(sep);
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

connect();
