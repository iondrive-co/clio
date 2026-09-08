
const { Terminal } = window;
const { FitAddon } = window.FitAddon;
const { WebLinksAddon } = window.WebLinksAddon;

const THEME = {
  background: '#000000',
  foreground: '#ffffff',
  cursor: '#ffffff',
  cursorAccent: '#000000',
  selectionBackground: '#ffffff',
  selectionForeground: '#000000',
  scrollbarSliderBackground: '#6e6e85',
  scrollbarSliderHoverBackground: '#8f8fa8',
  scrollbarSliderActiveBackground: '#aeaec8',
  overviewRulerBorder: '#000000',
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

const DEFAULT_FONT_SIZE = (11 * 96) / 72;
const FONT_MIN = 8;
const FONT_MAX = 40;
const FONT_KEY = 'clio.fontSize';

const SCROLLBAR_WIDTH = 18;

const MIN_COLS = 20;
const MIN_ROWS = 5;

const el = {
  tabs: document.getElementById('tabs'),
  newtab: document.getElementById('newtab'),
  newwindow: document.getElementById('newwindow'),
  windowname: document.getElementById('windowname'),
  panes: document.getElementById('panes'),
  status: document.getElementById('status'),
  ctxmenu: document.getElementById('ctxmenu'),
  ctxsub: document.getElementById('ctxsub'),
  picker: document.getElementById('picker'),
  fontUp: document.getElementById('font-up'),
  fontDown: document.getElementById('font-down'),
  devbadge: document.getElementById('devbadge'),
};

function loadFontSize() {
  try {
    const saved = Number(localStorage.getItem(FONT_KEY));
    if (Number.isFinite(saved) && saved >= FONT_MIN && saved <= FONT_MAX) return saved;
  } catch {
  }
  return DEFAULT_FONT_SIZE;
}

let fontSize = loadFontSize();

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
  }

  for (const pane of panes.values()) pane.term.options.fontSize = fontSize;
  resizeActive();
  updateFontButtons();
}

const stepUp = () => setFontSize(Math.floor(fontSize) + 1);
const stepDown = () => setFontSize(Math.ceil(fontSize) - 1);

function updateFontButtons() {
  const shown = Number.isInteger(fontSize) ? fontSize : fontSize.toFixed(1);
  el.fontUp.disabled = fontSize >= FONT_MAX;
  el.fontDown.disabled = fontSize <= FONT_MIN;
  el.fontUp.title = `Larger text (currently ${shown}px)`;
  el.fontDown.title = `Smaller text (currently ${shown}px)`;
}

const sessions = new Map();
const panes = new Map();
const termTitles = new Map();

let activeId = null;
let order = [];
let containerId = new URLSearchParams(location.search).get('c') || '';
let picking = new URLSearchParams(location.search).get('pick') === '1';
let windowDisplay = new URLSearchParams(location.search).get('d') || '';
let movedAway = false;
let windowName = null;
let ws = null;
let reconnectDelay = 250;
let HOME = '';
let bootstrapped = false;
let disowned = false;
let daemonReplaced = false;
let lastTabsSignature = null;
let renaming = false;
const waitingSince = new Map();
const PULSE_MS = 8000;
let pulseTimer = null;

const BLINK_IDLE_MS = 15000;
let browsers = [];
let hoveredLink = null;

function query() {
  const parts = [];
  if (containerId) parts.push(`c=${encodeURIComponent(containerId)}`);
  if (picking) parts.push('pick=1');
  if (windowDisplay) parts.push(`d=${encodeURIComponent(windowDisplay)}`);
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
    if (daemonReplaced) {
      location.reload();
      return;
    }

    reconnectDelay = 250;
    disowned = false;
    hideStatus();
    for (const pane of panes.values()) {
      pane.attached = false;
      pane.term.reset();
    }
    if (activeId) {
      attach(activeId);
      send({ t: 'focus', id: activeId });
    }
  };

  ws.onmessage = (event) => handle(JSON.parse(event.data));

  ws.onclose = (event) => {
    dropsInFlight.clear();
    if (event.code === 1012) {
      reconnectDelay = 250;
      daemonReplaced = true;
    }
    if (!disowned) reconnect();
  };

  ws.onerror = () => ws.close();
}

async function reconnect() {
  let verdict;
  let command = 'clio';
  try {
    const res = await fetch('/auth', { cache: 'no-store' });
    verdict = res.status === 403 ? 'rejected' : 'ok';
    if (verdict === 'rejected') {
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
  if (disowned) showDeadScreen();
  else showStatus('Not connected to the clio daemon yet — that did nothing.', 3000);
}

addEventListener('pagehide', () => {
  if (!containerId) return;
  if (movedAway) return;
  const url = `/gone?c=${encodeURIComponent(containerId)}`;
  if (navigator.sendBeacon?.(url)) return;
  try {
    ws?.send(JSON.stringify({ t: 'gone' }));
  } catch {
  }
});

function setDev(dev) {
  if (el.devbadge) el.devbadge.toggleAttribute('hidden', !dev);
  showTitle(dev ? 'clio (dev)' : 'clio');
}

function showTitle(text) {
  if (placeMark) return;
  if (document.title !== text) document.title = text;
}

function handle(msg) {
  switch (msg.t) {
    case 'sessions':
      if (msg.container && msg.container !== containerId) {
        containerId = msg.container;
        settle();
      }
      windowName = msg.name || null;
      setDev(msg.dev);
      if (!picking && placedFor !== containerId) {
        placedFor = containerId;
        applyGeometry(msg.geometry, msg.mark);
      }
      syncSessions(msg.sessions, msg.home);
      refreshTitle();
      answeringCheck();
      break;

    case 'groups':
      if (!picking) break;
      if (!msg.groups?.length && el.picker.hidden) {
        chooseNewWindow();
        break;
      }
      renderPicker(msg.groups || [], msg.error);
      break;

    case 'killed':
      showStatus(
        'This window’s page was killed — out of memory, most likely. ' +
          'Nothing in these tabs was lost; the shells kept running throughout.',
        12000,
      );
      break;

    case 'moved':
      movedAway = true;
      disowned = true;
      showMovedScreen(msg.display);
      try {
        ws?.close();
      } catch {
      }
      window.close();
      break;

    case 'placed':
      donePlacing();
      break;

    case 'reload':
      location.reload();
      break;

    case 'window':
      if (!msg.ok) showStatus(`Could not open a new window — ${msg.error}`, 6000);
      break;

    case 'tab':
      if (!msg.ok) showStatus(`Could not open a window for that tab — ${msg.error}`, 6000);
      break;

    case 'browsers':
      browsers = Array.isArray(msg.browsers) ? msg.browsers : [];
      break;

    case 'clipboard':
      if (typeof msg.text === 'string') ownClipboard = msg.text;
      break;

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
      if (pane) {
        pane.term.write(msg.data);
        nudgeBlink(pane);
      }
      break;
    }

    case 'dropneed':
      sendDropBytes(msg.drop, Array.isArray(msg.need) ? msg.need : []);
      break;

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
    if (picking) return;
    if (bootstrapped) {
      window.close();
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

function newWindow() {
  const cwd = activeId ? sessions.get(activeId)?.cwd : null;
  send({ t: 'newwindow', cwd });
}

let pickerEditing = false;
let confirmingDiscard = null;
let lastGroups = [];

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

function chooseNewWindow() {
  if (!picking) return;
  settle();
  newTab();
}

window.addEventListener('keydown', (event) => {
  if (picking && event.key === 'Escape') chooseNewWindow();
});

function pickerFallback() {
  if (!picking || !el.picker.hidden) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    setTimeout(pickerFallback, 1000);
    return;
  }
  chooseNewWindow();
}

setTimeout(pickerFallback, 4000);

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

function closeOthers(keepId) {
  if (!sessions.has(keepId)) return;
  activate(keepId);
  for (const id of [...sessions.keys()]) {
    if (id !== keepId) closeTab(id);
  }
}

function ensurePane(id) {
  let pane = panes.get(id);
  if (pane) return pane;

  const root = document.createElement('div');
  root.className = 'pane';
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
    overviewRuler: { width: SCROLLBAR_WIDTH },
    allowProposedApi: true,
    macOptionIsMeta: false,
    minimumContrastRatio: 1,
  });

  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(
    new WebLinksAddon(
      (event, uri) => {
        if (!event.ctrlKey) {
          showStatus('Ctrl+click to open a link — or right-click it to choose a browser.', 4000);
          return;
        }
        send({ t: 'openurl', url: uri });
      },
      {
        hover: (event, uri) => {
          hoveredLink = { id, url: uri };
        },
        leave: () => {
          hoveredLink = null;
        },
      },
    ),
  );
  term.open(termEl);

  term.onData((data) => {
    if (panes.get(id)?.replaying) return;
    if (ctrlClick(data)) return;
    nudgeBlink(panes.get(id));
    send({ t: 'input', id, data });
  });
  term.onResize(({ cols, rows }) => send({ t: 'resize', id, cols, rows }));
  term.onTitleChange((title) => {
    termTitles.set(id, title);
    renderTabs();
  });

  term.attachCustomKeyEventHandler((event) => !isShortcut(event));

  termEl.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    openContextMenu(event.clientX, event.clientY, id);
  });

  pane = { id, root, termEl, term, fit, attached: false, replaying: false, blinkTimer: null };
  panes.set(id, pane);
  nudgeBlink(pane);
  termEl.addEventListener('focusin', () => nudgeBlink(panes.get(id)));
  return pane;
}

function nudgeBlink(pane) {
  if (!pane) return;
  if (!pane.term.options.cursorBlink) pane.term.options.cursorBlink = true;
  clearTimeout(pane.blinkTimer);
  pane.blinkTimer = setTimeout(() => {
    if (panes.get(pane.id) !== pane) return;
    if (pane.term.options.cursorBlink) pane.term.options.cursorBlink = false;
  }, BLINK_IDLE_MS);
  pane.blinkTimer.unref?.();
}

const SGR_MOUSE = /^\x1b\[<(\d+);\d+;\d+[Mm]$/;
const MOUSE_CTRL = 16;
const MOUSE_WHEEL = 64;

function ctrlClick(data) {
  const sgr = SGR_MOUSE.exec(data);
  let button = null;
  if (sgr) button = Number(sgr[1]);
  else if (data.length === 6 && data.startsWith('\x1b[M')) button = data.charCodeAt(3) - 32;
  if (button === null || !Number.isFinite(button)) return false;
  return (button & MOUSE_CTRL) !== 0 && (button & MOUSE_WHEEL) === 0;
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
    const next = neighbour(id);
    if (next) activate(next);
  }
}

function neighbour(id) {
  const alive = (other) => other !== id && sessions.has(other);
  const at = order.indexOf(id);
  if (at < 0) return order.find(alive);
  for (let i = at - 1; i >= 0; i -= 1) if (alive(order[i])) return order[i];
  for (let i = at + 1; i < order.length; i += 1) if (alive(order[i])) return order[i];
  return null;
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
  send({ t: 'focus', id });
  resizeActive();
  pane.term.focus();

  renderTabs();
  refreshTitle();
}

function refreshTitle() {
  showWindowName();
  if (picking) {
    showTitle('clio — open a window');
    return;
  }
  if (windowName) {
    showTitle(windowName);
    return;
  }
  showTitle(activeId ? `${tabLabel(sessions.get(activeId))} — clio` : 'clio');
}

function showWindowName() {
  const label = el.windowname;
  if (!label) return;
  label.textContent = windowName || 'name this window';
  label.classList.toggle('unnamed', !windowName);
  label.title = windowName ? `Rename this window (“${windowName}”)` : 'Name this window';
}

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
  requestAnimationFrame(() => requestAnimationFrame(() => safeFit(pane)));
}

function measure() {
  const pane = panes.get(activeId);
  if (pane) return { cols: pane.term.cols, rows: pane.term.rows };
  return { cols: 80, rows: 24 };
}

function isShellDefaultTitle(title) {
  return /^[^@\s]+@[^:\s]+:/.test(title.trim());
}

function tabLabel(meta) {
  if (!meta) return 'shell';
  if (meta.title) return meta.title;

  if (meta.ext?.title) return meta.ext.title;

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

function pulsing(id, meta, now) {
  if (!meta.waiting || id === activeId) {
    waitingSince.delete(id);
    return false;
  }
  if (!waitingSince.has(id)) waitingSince.set(id, now);
  return now - waitingSince.get(id) < PULSE_MS;
}

function schedulePulseEnd(now) {
  if (pulseTimer) clearTimeout(pulseTimer);
  pulseTimer = null;
  let soonest = Infinity;
  for (const [id, since] of waitingSince) {
    if (!order.includes(id)) {
      waitingSince.delete(id);
      continue;
    }
    const left = since + PULSE_MS - now;
    if (left > 0 && left < soonest) soonest = left;
  }
  if (soonest !== Infinity) pulseTimer = setTimeout(() => renderTabs(), soonest + 20);
}

function renderTabs(force = false) {
  if (renaming && !force) return;

  const now = Date.now();
  const signature = JSON.stringify(
    order.map((id) => {
      const meta = sessions.get(id);
      return meta
        ? [
            id,
            tabLabel(meta),
            meta.status,
            meta.unseenOutput,
            meta.waiting,
            id === activeId,
            pulsing(id, meta, now),
          ]
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
      (meta.waiting && id !== activeId ? ' waiting' : '') +
      (pulsing(id, meta, now) ? ' pulsing' : '');
    tab.draggable = true;
    tab.dataset.id = id;
    tab.title = [tabLabel(meta), meta.cwd].filter(Boolean).join('\n');

    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = tabLabel(meta);
    tab.append(title);

    const close = document.createElement('span');
    close.className = 'tab-close';
    close.textContent = '×';
    close.title = 'Close tab';
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

  el.tabs.append(el.newtab);

  schedulePulseEnd(now);
}

function startRename(tab, id) {
  const holder = tab.querySelector('.tab-title');
  const meta = sessions.get(id);
  const input = document.createElement('input');
  input.value = meta?.title || tabLabel(meta);
  holder.replaceChildren(input);
  input.focus();
  input.select();

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

const TAB_MIME = 'application/x-clio-tab';

let dragId = null;

let adopting = null;

let dragGrab = null;

const POP_WAIT_MS = 300;

function carriesTab(dt) {
  return !!dt && [...dt.types].includes(TAB_MIME);
}

function wireDrag(tab, id) {
  tab.ondragstart = (event) => {
    dragId = id;
    const rect = tab.getBoundingClientRect();
    dragGrab = { dx: event.clientX - rect.left, width: rect.width };
    tab.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(TAB_MIME, JSON.stringify({ id, container: containerId }));
  };

  tab.ondragend = (event) => {
    const dragged = dragId;
    dragId = null;
    dragGrab = null;
    tab.classList.remove('dragging');
    clearDropMarkers();
    renderTabs();
    if (!dragged) return;

    if (within(event.clientX, event.clientY)) return;
    popOut(dragged, { x: event.screenX, y: event.screenY });
  };
}

let escapedAt = 0;

window.addEventListener('keyup', (event) => {
  if (event.key === 'Escape') escapedAt = Date.now();
});

function within(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return true;
  return x >= 0 && y >= 0 && x <= window.innerWidth && y <= window.innerHeight;
}

function popOut(id, at) {
  if (order.length < 2) return;

  const letGoAt = Date.now();
  setTimeout(() => {
    if (escapedAt >= letGoAt) return;
    if (!sessions.has(id)) return;
    send({ t: 'poptab', id, geometry: popGeometry(at) });
  }, POP_WAIT_MS);
}

function popGeometry(at) {
  const now = currentGeometry();
  const left = Number.isFinite(window.screen?.availLeft) ? window.screen.availLeft : 0;
  const top = Number.isFinite(window.screen?.availTop) ? window.screen.availTop : 0;
  return {
    x: Math.max(left, Math.round(at.x - 60)),
    y: Math.max(top, Math.round(at.y - 16)),
    width: now?.width || window.outerWidth,
    height: now?.height || window.outerHeight,
  };
}

const centreOf = (rect) => rect.left + rect.width / 2;

// A tab goes where the middle of it has got to: it passes a neighbour when its
// own middle passes that neighbour's middle. That is what the browser's own tab
// strips do, and it is the only measure that reads the same at every width.
//
// Until 2026-09-08 this measured the *leading edge* of the dragged tab instead,
// and every rightward drag landed one or two whole tabs too far along: the
// leading edge is a tab-width out in front of the tab, so it crossed middles
// the tab itself had not reached and counted them as passed. The error grew
// with the width of the tab being dragged — measured on a row like the real
// ones, two tabs for a 204px claude tab among 90px ones, one for a narrow tab —
// so it could not even be aimed off by hand. A row of equal-width tabs hides it
// completely, which is why the tests did not see it: they moved a tab by
// exactly one tab-width, which in such a row is the same aim.
//
// The pointer is not the measure and never was: a tab held near its right edge
// has its whole body to the left of the pointer, and aiming the pointer throws
// it a tab the other way. `dragGrab.dx` is where the tab was taken hold of, so
// `clientX - dx` is where its left edge is now. A tab dragged in from another
// window is not in this row and has no width here, so for that one the pointer
// is all there is.
function insertionAt(clientX) {
  const tabs = [...el.tabs.querySelectorAll('.tab[data-id]')];
  if (!tabs.length) return null;

  const home = tabs.findIndex((tab) => tab.dataset.id === dragId);
  const rest = tabs.filter((tab, index) => index !== home);
  if (!rest.length) return null;

  const own = home === -1 ? null : tabs[home].getBoundingClientRect();
  const width = dragGrab?.width || own?.width || 0;
  const aim = dragGrab ? clientX - dragGrab.dx + width / 2 : clientX;

  // Landing exactly on a neighbour's middle is a tie, and a drag of one whole
  // tab is how a hand lands on it. Half a pixel of slack, given to the
  // direction the drag was going, means such a drag passes rather than sticks.
  const slack = own ? Math.sign(aim - centreOf(own)) * 0.5 : 0;

  for (const tab of rest) {
    if (centreOf(tab.getBoundingClientRect()) > aim + slack) return { tab, before: true };
  }
  return { tab: rest[rest.length - 1], before: false };
}

function orderWith(id, spot) {
  if (spot.tab.dataset.id === id) return [...order];
  const next = order.filter((other) => other !== id);
  const index = next.indexOf(spot.tab.dataset.id);
  if (index === -1) return [...next, id];
  next.splice(spot.before ? index : index + 1, 0, id);
  return next;
}

function changesRow(next) {
  return next.length !== order.length || next.some((id, i) => id !== order[i]);
}

// A tab drag is aimed along the row, but it is not caught by the row alone.
// The row is 31px tall at the very top of the window, and while it was the only
// thing listening, a drag that sank below it landed nowhere: no marker, no
// reorder, no complaint. Measured on 2026-09-08 — a tab held in the middle and
// let go 20px lower than it was grabbed did nothing at all, which is most of
// the drags a hand makes.
//
// So the whole window takes a dropped tab, and where it lands is read off the
// horizontal aim by itself. Nothing else in a window wants a tab: file and text
// drops carry their own types and `droppable` turns this one away, and a tab let
// go outside every window pops out from `ondragend` instead. A drag straight
// down still does nothing, because `changesRow` sees that the order it would
// produce is the order already there.
function wireStrip() {
  window.addEventListener('dragover', (event) => {
    if (!carriesTab(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    clearDropMarkers();
    if (!dragId) el.tabs.classList.add('taking');
    const spot = insertionAt(event.clientX);
    if (!spot || (dragId && !changesRow(orderWith(dragId, spot)))) return;
    spot.tab.classList.add(spot.before ? 'drop-before' : 'drop-after');
  });

  window.addEventListener('dragleave', (event) => {
    if (event.relatedTarget !== null) return;
    clearDropMarkers();
  });

  window.addEventListener('drop', (event) => {
    if (!carriesTab(event.dataTransfer)) return;
    event.preventDefault();
    const spot = insertionAt(event.clientX);
    clearDropMarkers();

    let dropped = null;
    try {
      dropped = JSON.parse(event.dataTransfer.getData(TAB_MIME));
    } catch {
    }
    if (!dropped?.id || !spot) return;

    const next = orderWith(dropped.id, spot);

    if (dropped.container === containerId) {
      if (!sessions.has(dropped.id)) return;
      if (!changesRow(next)) return;
      order = next;
      renderTabs(true);
      send({ t: 'reorder', ids: order });
      return;
    }

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

function buildMenu(id, link) {
  const pane = panes.get(id);
  const selection = pane ? pane.term.getSelection() : '';
  const others = order.filter((other) => other !== id && sessions.has(other)).length;

  const entries = [];

  if (link) {
    entries.push(
      {
        label: 'Open Link',
        key: 'Ctrl+Click',
        run: () => send({ t: 'openurl', url: link }),
      },
      {
        label: 'Open Link In',
        submenu: browsers.length
          ? browsers.map((browser) => ({
              label: browser.name,
              run: () => send({ t: 'openurl', url: link, browser: browser.id }),
            }))
          : [{ label: 'No browsers found', disabled: true }],
      },
      { sep: true },
    );
  }

  entries.push({
    label: 'Copy',
    key: 'Ctrl+Insert',
    disabled: !selection,
    run: () => copySelection(id),
  });

  if (!selection && pane && pane.term.modes?.mouseTrackingMode !== 'none') {
    entries.push({ label: 'Hold Shift to select here', disabled: true });
  }

  entries.push(
    { label: 'Paste', key: 'Shift+Insert', run: () => paste(id) },
    {
      label: 'Select All',
      disabled: !pane,
      run: () => {
        pane.term.selectAll();
        pane.term.focus();
      },
    },
    { sep: true },
    { label: 'New Tab', key: 'Ctrl+Shift+T', run: newTab },
    {
      label: 'Rename Tab',
      run: () => {
        const tab = el.tabs.querySelector(`[data-id="${id}"]`);
        if (tab) startRename(tab, id);
      },
    },
    { label: 'Close Tab', run: () => closeTab(id) },
    {
      label: others === 1 ? 'Close Other Tab' : `Close Other Tabs (${others})`,
      disabled: !others,
      run: () => confirmCloseOthers(id, others),
    },
  );

  return entries;
}

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

let menuAt = { x: 0, y: 0 };

function openContextMenu(x, y, id) {
  menuAt = { x, y };
  const link = hoveredLink && hoveredLink.id === id ? hoveredLink.url : null;
  renderMenu(buildMenu(id, link));
}

function renderMenu(entries) {
  const menu = el.ctxmenu;
  closeSubmenu();
  menu.replaceChildren();

  let focusMe = null;

  for (const entry of entries) {
    if (entry.sep) {
      const sep = document.createElement('div');
      sep.className = 'sep';
      menu.append(sep);
      continue;
    }

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

    menu.append(menuItem(entry, true));
  }

  menu.hidden = false;
  menu.style.left = `${menuAt.x}px`;
  menu.style.top = `${menuAt.y}px`;
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 4}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 4}px`;

  focusMe?.focus();
  focusMe?.select();
}

function menuItem(entry, top) {
  const item = document.createElement('div');
  item.className =
    'item' + (entry.disabled ? ' disabled' : '') + (entry.danger ? ' danger' : '');

  const label = document.createElement('span');
  if ('checked' in entry) {
    const tick = document.createElement('span');
    tick.className = 'tick';
    tick.textContent = entry.checked ? '✓' : '';
    label.append(tick);
  }
  label.append(entry.label);
  item.append(label);

  if (top && entry.submenu) {
    item.classList.add('has-sub');
    const arrow = document.createElement('span');
    arrow.className = 'key';
    arrow.textContent = '›';
    item.append(arrow);
    item.onmouseenter = () => openSubmenu(item, entry.submenu);
    item.onclick = () => openSubmenu(item, entry.submenu);
    return item;
  }

  if (entry.key) {
    const key = document.createElement('span');
    key.className = 'key';
    key.textContent = entry.key;
    item.append(key);
  }

  if (top) item.onmouseenter = closeSubmenu;

  if (!entry.disabled) {
    item.onclick = () => {
      closeContextMenu();
      entry.run();
    };
  }

  return item;
}

function openSubmenu(anchor, entries) {
  const sub = el.ctxsub;
  sub.replaceChildren(...entries.map((entry) => menuItem(entry, false)));
  sub.hidden = false;
  for (const item of el.ctxmenu.children) item.classList.toggle('sub-open', item === anchor);

  const from = anchor.getBoundingClientRect();
  const menu = el.ctxmenu.getBoundingClientRect();
  sub.style.left = `${menu.right - 2}px`;
  sub.style.top = `${from.top - 4}px`;

  const rect = sub.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    sub.style.left = `${Math.max(4, menu.left - rect.width + 2)}px`;
  }
  if (rect.bottom > window.innerHeight) {
    sub.style.top = `${Math.max(4, window.innerHeight - rect.height - 4)}px`;
  }
}

function closeSubmenu() {
  el.ctxsub.hidden = true;
  el.ctxsub.replaceChildren();
  for (const item of el.ctxmenu.children) item.classList.remove('sub-open');
}

function closeContextMenu() {
  closeSubmenu();
  el.ctxmenu.hidden = true;
}

window.addEventListener('mousedown', (event) => {
  if (el.ctxmenu.hidden) return;
  if (el.ctxmenu.contains(event.target) || el.ctxsub.contains(event.target)) return;
  closeContextMenu();
});
window.addEventListener('blur', closeContextMenu);

const CLIPBOARD_WAIT_MS = 600;

let ownClipboard = '';

function beforeLong(promise) {
  let timer;
  const clock = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('the clipboard never answered')), CLIPBOARD_WAIT_MS);
  });
  return Promise.race([promise, clock]).finally(() => clearTimeout(timer));
}

async function writeClipboard(text) {
  if (!text) return false;
  ownClipboard = text;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ t: 'clipboard', text }));
  }

  try {
    await beforeLong(navigator.clipboard.writeText(text));
    return true;
  } catch {
  }
  return execCopy(text);
}

function execCopy(text) {
  const held = document.activeElement;
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('aria-hidden', 'true');
  field.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0';
  document.body.append(field);
  field.focus();
  field.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  field.remove();
  if (held instanceof HTMLElement) held.focus();
  return ok;
}

async function readClipboard() {
  if (await mayReadClipboard()) {
    try {
      const text = await beforeLong(navigator.clipboard.readText());
      if (text) return text;
    } catch {
    }
  }
  return ownClipboard;
}

async function mayReadClipboard() {
  try {
    const status = await beforeLong(navigator.permissions.query({ name: 'clipboard-read' }));
    return status.state !== 'denied';
  } catch {
    return true;
  }
}

async function copySelection(id) {
  const text = panes.get(id)?.term.getSelection();
  if (!text) return false;
  if (!(await writeClipboard(text))) {
    showStatus('The desktop clipboard is closed to this window — copied within clio only.', 3000);
  }
  return true;
}

async function paste(id) {
  const text = await readClipboard();
  if (!text) {
    showStatus('Nothing to paste. Shift+Insert pastes what the desktop is holding.', 4000);
    return;
  }
  pasteInto(id, text);
}

const dropsInFlight = new Map();

let dropSeq = 0;
const dropToken = () => `d${Date.now().toString(36)}-${dropSeq++}`;

function droppable(dt) {
  if (!dt) return false;
  const types = [...dt.types];
  if (types.includes(TAB_MIME)) return false;
  return types.includes('Files') || types.includes('text/uri-list') || types.includes('text/plain');
}

function dropTargetFor(event) {
  const node = event.target instanceof Element ? event.target : null;
  const pane = node?.closest('.pane[data-id]');
  if (pane && sessions.has(pane.dataset.id)) return { id: pane.dataset.id, node: pane };

  const tab = node?.closest('#tabs [data-id]');
  if (tab && sessions.has(tab.dataset.id)) return { id: tab.dataset.id, node: tab };

  if (activeId && panes.has(activeId)) return { id: activeId, node: panes.get(activeId).root };
  return null;
}

let dropMark = null;

function markDrop(node) {
  if (dropMark === node) return;
  dropMark?.classList.remove('dropping');
  dropMark = node || null;
  dropMark?.classList.add('dropping');
}

function droppedFiles(dt) {
  const out = [];
  const items = dt.items;
  for (let i = 0; items && i < items.length; i++) {
    const item = items[i];
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (!file) continue;
    const entry = item.webkitGetAsEntry?.();
    out.push({ file, dir: !!entry?.isDirectory });
  }
  if (!out.length) {
    for (let i = 0; dt.files && i < dt.files.length; i++) out.push({ file: dt.files[i], dir: false });
  }
  return out.slice(0, 20);
}

window.addEventListener('dragover', (event) => {
  if (dragId) return;
  if (!droppable(event.dataTransfer)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
  markDrop(dropTargetFor(event)?.node);
});

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

function readBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error || new Error('unreadable'));
    reader.readAsDataURL(file);
  });
}

async function sendDropBytes(token, need) {
  const pending = dropsInFlight.get(token);
  if (!pending) return;

  const names = need.map((index) => pending.files[index]?.file.name).filter(Boolean);
  if (names.length) showStatus(`Copying ${names.join(', ')} into clio…`, 15000);

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

function pasteInto(id, text) {
  const pane = panes.get(id);
  if (!pane || !text) return;
  pane.term.focus();
  pane.term.paste(text);
}

function isShortcut(event) {
  if (event.type !== 'keydown') return false;

  if (event.ctrlKey && event.shiftKey && !event.altKey) {
    return ['C', 'V', 'T', 'W', 'D', 'Tab'].includes(normalizeKey(event));
  }
  if (event.ctrlKey && !event.shiftKey && !event.altKey) {
    if (event.key === 'Tab') return true;
    const key = normalizeKey(event);
    if (key === 'Insert') return true;
    if (key === 'V') return true;
    if (key === 'C') return Boolean(activeId && panes.get(activeId)?.term.hasSelection());
  }
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
      case 'Insert':
      case 'C':
        if (!activeId) break;
        copySelection(activeId);
        if (key === 'C' && !event.shiftKey) panes.get(activeId)?.term.clearSelection();
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

const GRIP_SLOP = 3;
const GRIP_MIN = { width: 320, height: 160 };

let gripping = null;

function gripResize(edge, from, dx, dy) {
  let { x, y, width, height } = from;
  if (edge.includes('e')) width = from.width + dx;
  if (edge.includes('s')) height = from.height + dy;
  if (edge.includes('w')) {
    width = Math.max(GRIP_MIN.width, from.width - dx);
    x = from.x + from.width - width;
  }
  width = Math.max(GRIP_MIN.width, width);
  height = Math.max(GRIP_MIN.height, height);
  if (edge.includes('w') && width > from.width) {
    window.moveTo(x, y);
    window.resizeTo(width, height);
  } else {
    window.resizeTo(width, height);
    if (edge.includes('w')) window.moveTo(x, y);
  }
}

function wireGrips() {
  for (const grip of document.querySelectorAll('.grip')) {
    grip.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      const from = currentGeometry();
      if (!from) return;
      event.preventDefault();
      grip.setPointerCapture(event.pointerId);
      gripping = { edge: grip.dataset.edge, from, x: event.screenX, y: event.screenY, frame: 0 };
    });

    grip.addEventListener('pointermove', (event) => {
      if (!gripping) return;
      const dx = event.screenX - gripping.x;
      const dy = event.screenY - gripping.y;
      if (Math.abs(dx) <= GRIP_SLOP && Math.abs(dy) <= GRIP_SLOP) return;
      if (gripping.frame) return;
      gripping.frame = requestAnimationFrame(() => {
        if (!gripping) return;
        gripping.frame = 0;
        gripResize(gripping.edge, gripping.from, dx, dy);
      });
    });

    const done = (event) => {
      if (!gripping) return;
      cancelAnimationFrame(gripping.frame);
      gripping = null;
      if (grip.hasPointerCapture(event.pointerId)) grip.releasePointerCapture(event.pointerId);
      panes.get(activeId)?.term.focus();
    };
    grip.addEventListener('pointerup', done);
    grip.addEventListener('pointercancel', done);
  }
}

const GEOMETRY_POLL_MS = 1000;
const GEOMETRY_SLACK = 2;

const PLACE_WAIT_MS = 8000;

let placedFor = null;
let wanted = null;
let placeMark = null;
let placeTimer = null;
let lastGeometry = null;

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

function applyGeometry(saved, mark) {
  wanted = saved || null;
  const now = currentGeometry();
  if (!saved || !now || !moved(now, saved)) return;
  window.resizeTo(saved.width, saved.height);
  window.moveTo(saved.x, saved.y);
  const landed = currentGeometry();
  if (mark && landed && moved(landed, saved)) askToBePlaced(mark);
}

function askToBePlaced(mark) {
  placeMark = mark;
  document.title = mark;
  send({ t: 'place' });
  clearTimeout(placeTimer);
  placeTimer = setTimeout(donePlacing, PLACE_WAIT_MS);
}

function donePlacing() {
  clearTimeout(placeTimer);
  if (!placeMark) return;
  placeMark = null;
  refreshTitle();
}

function reportGeometry() {
  if (picking || placedFor !== containerId) return;
  const now = currentGeometry();
  if (!now) return;
  const before = lastGeometry;
  lastGeometry = now;

  if (!before) {
    if (!wanted) sendGeometry(now);
    return;
  }
  if (!moved(before, now)) return;
  sendGeometry(now);
}

function sendGeometry(now) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ t: 'geometry', ...now }));
  }
}

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

function showMovedScreen(display) {
  hideStatus();
  const screen = document.getElementById('deadscreen');
  screen.replaceChildren();

  const card = document.createElement('div');
  card.className = 'card';

  const heading = document.createElement('h1');
  heading.textContent = 'These tabs are in another window now';
  card.append(heading);

  const body = document.createElement('p');
  body.textContent =
    `clio was run on ${display ? `display ${display}` : 'another display'}, so these tabs went ` +
    'to a window there — the screen somebody is at. Nothing was lost and no shell was ' +
    'restarted; this frame is all that is left here, and it can be closed.';
  card.append(body);

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
  quietSaid = false;
}

let quietSaid = false;

function answeringCheck() {
  const meta = sessions.get(activeId);
  const quiet = meta && meta.unanswered > 0 && meta.unansweredFor >= 3;
  if (quiet) {
    const chars = meta.unanswered === 1 ? '1 character' : `${meta.unanswered} characters`;
    showStatus(
      `${chars} typed here, and nothing in this tab has answered — the program ` +
        'in it is not reading. What you typed is in the terminal, not lost.',
    );
    quietSaid = true;
    return;
  }
  if (quietSaid) hideStatus();
}

wireStrip();
wireGrips();

el.newtab.onclick = newTab;
el.windowname.onclick = (event) => {
  const box = event.currentTarget.getBoundingClientRect();
  menuAt = { x: box.left, y: box.bottom + 2 };
  renameWindowMenu();
};

el.newwindow.onclick = () => {
  newWindow();
  panes.get(activeId)?.term.focus();
};
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

document.addEventListener('focusout', (event) => {
  if (event.relatedTarget) return;
  if (!document.hasFocus()) return;
  setTimeout(() => {
    if (!document.hasFocus() || document.activeElement !== document.body) return;
    panes.get(activeId)?.term.focus();
  }, 0);
});

setInterval(reportGeometry, GEOMETRY_POLL_MS);

connect();
