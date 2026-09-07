import { mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync, execSync, spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

delete process.env.DISPLAY;
delete process.env.WAYLAND_DISPLAY;

const SANDBOX = mkdtempSync(join(tmpdir(), 'clio-tabmove-'));
process.env.XDG_RUNTIME_DIR = join(SANDBOX, 'run');
process.env.XDG_STATE_HOME = join(SANDBOX, 'state');
process.env.CLIO_DEV = '1';
mkdirSync(process.env.XDG_RUNTIME_DIR, { recursive: true });
mkdirSync(process.env.XDG_STATE_HOME, { recursive: true });

const HANDSHAKE = join(process.env.XDG_RUNTIME_DIR, 'clio', 'daemon.json');
const STATE_FILE = join(process.env.XDG_STATE_HOME, 'clio', 'state.json');
const SHOTS = join(ROOT, 'test', 'screenshots');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let passed = 0;
let failed = 0;

function check(label, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}${detail ? `  — ${detail}` : ''}`);
  }
}

function installed(command) {
  try {
    execSync(`command -v ${command}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const WINDOW_MANAGERS = ['xfwm4', 'openbox', 'marco', 'icewm', 'fluxbox', 'jwm', 'metacity'];

const started = [];

process.on('exit', () => {
  try {
    execFileSync(join(ROOT, 'bin', 'clio'), ['stop'], { stdio: 'ignore' });
  } catch {
  }
  while (started.length) {
    try {
      started.pop().kill();
    } catch {
    }
  }
  try {
    rmSync(SANDBOX, { recursive: true, force: true });
  } catch {
  }
});

async function startDisplay() {
  if (!installed('Xvfb')) return null;
  const wm = WINDOW_MANAGERS.find(installed);
  if (!wm) return null;

  for (let n = 95; n < 130; n++) {
    if (existsSync(`/tmp/.X${n}-lock`)) continue;
    const display = `:${n}`;

    const xvfb = spawn('Xvfb', [display, '-screen', '0', '1920x1080x24'], { stdio: 'ignore' });
    started.push(xvfb);
    await sleep(1500);
    if (xvfb.exitCode !== null) continue;

    started.push(spawn(wm, [], { stdio: 'ignore', env: { ...process.env, DISPLAY: display } }));
    await sleep(1500);
    return display;
  }
  return null;
}

const clio = (...args) =>
  execFileSync(join(ROOT, 'bin', 'clio'), args, { encoding: 'utf8', env: process.env });

const handshake = () => JSON.parse(readFileSync(HANDSHAKE, 'utf8'));
const savedState = () => JSON.parse(readFileSync(STATE_FILE, 'utf8'));

async function status() {
  const { port, token } = handshake();
  const res = await fetch(`http://127.0.0.1:${port}/status?token=${token}`);
  return res.json();
}

async function whereIs(id) {
  const { containers } = await status();
  for (const container of containers) {
    const index = container.sessions.findIndex((s) => s.id === id);
    if (index !== -1) return { container: container.id, index, of: container.sessions.length };
  }
  return null;
}

async function connect(container = '') {
  const { port, token } = handshake();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}&c=${container}`, {
    origin: `http://127.0.0.1:${port}`,
  });
  const client = { ws, sessions: [], container: null, geometry: null, output: new Map(), notes: [] };
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.t === 'sessions') {
      client.container = msg.container;
      client.sessions = msg.sessions;
      if (msg.geometry) client.geometry = msg.geometry;
    }
    if (msg.t === 'created') client.created = msg.session;
    if (msg.t === 'attached') client.replayed = msg.scrollback || '';
    if (msg.t === 'data') client.output.set(msg.id, (client.output.get(msg.id) || '') + msg.data);
    if (msg.t === 'tab') client.notes.push(msg);
  });
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  client.send = (msg) => ws.send(JSON.stringify(msg));
  client.ids = () => client.sessions.map((s) => s.id);
  client.open = async (cwd = process.env.HOME) => {
    client.created = null;
    client.send({ t: 'create', cwd, cols: 80, rows: 24 });
    for (let i = 0; i < 40 && !client.created; i++) await sleep(100);
    return client.created?.id || null;
  };
  return client;
}

console.log(`clio tab-move test — sandbox at ${SANDBOX}`);
console.log(clio('start').trim());
await sleep(500);

console.log('\n1. a tab handed from one window to another');

const alpha = await connect();
await sleep(400);
const keep = await alpha.open();
const going = await alpha.open();
await sleep(500);

const beta = await connect();
await sleep(400);
const theirs = await beta.open();
await sleep(500);

check('two windows, three tabs', alpha.container !== beta.container && !!keep && !!going && !!theirs,
  `${alpha.container}:${alpha.ids()} ${beta.container}:${beta.ids()}`);

alpha.send({ t: 'attach', id: going, cols: 80, rows: 24 });
await sleep(500);
alpha.send({ t: 'input', id: going, data: 'echo BEFORE-THE-MOVE\r' });
await sleep(1200);

beta.send({ t: 'adopttab', id: going, ids: [going, theirs] });
await sleep(1000);

const landed = await whereIs(going);
check('the tab is in the window it was dropped on', landed?.container === beta.container,
  JSON.stringify(landed));
check('and in the place it was dropped', landed?.index === 0 && landed?.of === 2, JSON.stringify(landed));
check('the window it left has only its own tabs', (await whereIs(keep))?.of === 1);
check('the window it left was told', !alpha.ids().includes(going), JSON.stringify(alpha.ids()));
check('the window that took it was told', beta.ids().includes(going), JSON.stringify(beta.ids()));

beta.send({ t: 'attach', id: going, cols: 100, rows: 30 });
await sleep(800);
check('the scrollback came with it', /BEFORE-THE-MOVE/.test(beta.replayed || ''),
  JSON.stringify((beta.replayed || '').slice(-80)));

beta.send({ t: 'input', id: going, data: 'echo AFTER-THE-MOVE\r' });
await sleep(1500);
check('the shell is still running and answers the new window',
  /AFTER-THE-MOVE/.test(beta.output.get(going) || ''),
  JSON.stringify((beta.output.get(going) || '').slice(-80)));

alpha.send({ t: 'input', id: going, data: 'echo FROM-THE-OLD-WINDOW\r' });
alpha.send({ t: 'close', id: going });
await sleep(1500);
check('the window it left can no longer type into it',
  !/FROM-THE-OLD-WINDOW/.test(beta.output.get(going) || ''));
check('nor close it', (await whereIs(going))?.container === beta.container);

console.log('\n2. what may not be moved');

const before = JSON.stringify((await status()).containers);
beta.send({ t: 'adopttab', id: 'nosuchtab', ids: [] });
beta.send({ t: 'adopttab', id: theirs, ids: [theirs] });
await sleep(600);
check('a tab that does not exist, and one already here, change nothing',
  JSON.stringify((await status()).containers) === before);

console.log('\n3. the last tab of a window, handed over');

beta.send({ t: 'adopttab', id: keep, ids: [keep, going, theirs] });
await sleep(1000);
const containers = (await status()).containers.map((c) => c.id);
check('the emptied window is gone', !containers.includes(alpha.container), JSON.stringify(containers));
check('all three tabs are in the one window',
  (await whereIs(keep))?.of === 3 && (await whereIs(going))?.container === beta.container);
check('in the order they were dropped in',
  (await whereIs(keep))?.index === 0 && (await whereIs(going))?.index === 1,
  JSON.stringify(await whereIs(going)));

await sleep(1200);
const onDisk = savedState().sessions.find((s) => s.id === going);
check('the move is on disk', onDisk?.container === beta.container, JSON.stringify(onDisk?.container));

console.log('\n4. a tab pulled out into a window of its own');

const lonely = await connect();
await sleep(400);
const only = await lonely.open();
await sleep(500);
lonely.send({ t: 'poptab', id: only, geometry: { x: 100, y: 100, width: 900, height: 600 } });
await sleep(1200);
check('the only tab in a window stays where it is', (await whereIs(only))?.container === lonely.container,
  JSON.stringify(await whereIs(only)));

lonely.send({ t: 'close', id: only });
await sleep(800);
lonely.ws.close();
alpha.ws.close();
await sleep(500);

const display = await startDisplay();
const canDrag = display && installed('wmctrl') && installed('xdotool');
if (!canDrag) {
  console.log('\n5. real windows — skipped: needs Xvfb, a window manager, wmctrl and xdotool');
  beta.ws.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
process.env.DISPLAY = display;
console.log(`\n5. two windows on display ${display}, dragged with a real mouse`);

const xdotool = (...args) => execFileSync('xdotool', args, { encoding: 'utf8', env: process.env });
const wmctrl = (...args) => execFileSync('wmctrl', args, { encoding: 'utf8', env: process.env });
const windowCount = () => wmctrl('-l').trim().split('\n').filter(Boolean).length;
const windowNamed = (name) =>
  wmctrl('-l')
    .trim()
    .split('\n')
    .find((line) => line.split(/\s+/).slice(3).join(' ') === name)
    ?.split(/\s+/)[0] || null;

const PLACE = {
  left: { x: 0, y: 0, w: 700, h: 450 },
  right: { x: 760, y: 0, w: 700, h: 450 },
};
const DESKTOP = { x: 900, y: 560 };

function place(name, at) {
  const win = windowNamed(name);
  if (!win) return false;
  wmctrl('-i', '-r', win, '-e', `0,${at.x},${at.y},${at.w},${at.h}`);
  return true;
}

async function onScreen(count) {
  for (let i = 0; i < 60; i++) {
    const shown = (await status()).containers.filter((c) => c.onScreen);
    if (shown.length >= count && windowCount() >= count) return shown;
    await sleep(500);
  }
  return [];
}

for (const id of beta.ids()) beta.send({ t: 'close', id });
await sleep(1500);
beta.ws.close();
await sleep(1500);

const over = (await status()).containers;
check('nothing is left over from the sections above', !over.length, JSON.stringify(over));

clio();
const one = await onScreen(1);
check('one window on screen', one.length === 1,
  `${JSON.stringify((await status()).containers)} :: ${wmctrl('-l')}`);

const left = await connect(one[0]?.id || '');
await sleep(600);
check('watching the window that is on screen', left.container === one[0]?.id,
  `${left.container} vs ${one[0]?.id}`);
left.send({ t: 'renamewindow', name: 'left' });
const dragMe = await left.open();
await sleep(1500);

clio();
const two = await onScreen(2);
check('a second window', two.length === 2, wmctrl('-l'));

const right = await connect(two.find((c) => c.id !== left.container)?.id || '');
await sleep(600);
check('watching the second one', right.container !== left.container && !!right.container,
  `${right.container} vs ${left.container}`);
right.send({ t: 'renamewindow', name: 'right' });
await sleep(1500);

const TABBAR_HEIGHT = 32;
const TAB_WIDTH = 90;
left.sessions.forEach((s, i) => left.send({ t: 'rename', id: s.id, title: `L${i + 1}` }));
right.sessions.forEach((s, i) => right.send({ t: 'rename', id: s.id, title: `R${i + 1}` }));
await sleep(1000);

const placedLeft = place('left', PLACE.left);
const placedRight = place('right', PLACE.right);
check('both windows can be found by name and moved', placedLeft && placedRight, wmctrl('-l'));

async function viewport(containerId, frame) {
  for (let i = 0; i < 40; i++) {
    const geometry = savedState().containers.find((c) => c.id === containerId)?.geometry;
    if (geometry && Math.abs(geometry.x - frame.x) < 60 && Math.abs(geometry.y - frame.y) < 60) {
      return geometry;
    }
    await sleep(500);
  }
  return null;
}

function tabAt(geometry, index, fraction = 0.5) {
  if (!geometry) return null;
  return {
    x: Math.round(geometry.x + (index + fraction) * TAB_WIDTH),
    y: Math.round(geometry.y + TABBAR_HEIGHT / 2),
  };
}

function drag(from, to, { held = null, abandon = false } = {}) {
  xdotool('mousemove', String(from.x), String(from.y), 'sleep', '0.4');
  xdotool('mousedown', '1', 'sleep', '0.4');
  const steps = 14;
  for (let i = 1; i <= steps; i++) {
    xdotool(
      'mousemove',
      String(Math.round(from.x + ((to.x - from.x) * i) / steps)),
      String(Math.round(from.y + ((to.y - from.y) * i) / steps)),
      'sleep',
      '0.12',
    );
  }
  xdotool('mousemove', String(to.x), String(to.y), 'sleep', '0.8');
  if (held) held();
  if (abandon) xdotool('key', 'Escape', 'sleep', '0.6');
  xdotool('mouseup', '1', 'sleep', '0.5');
}

function shot(name) {
  if (!installed('import')) return;
  try {
    execFileSync('import', ['-window', 'root', join(SHOTS, name)], { env: process.env });
    console.log(`  · screenshot: ${join(SHOTS, name)}`);
  } catch {
  }
}

const leftAt = await viewport(left.container, PLACE.left);
const rightAt = await viewport(right.container, PLACE.right);
const apart = !!leftAt && !!rightAt && rightAt.x - leftAt.x > 300;
check('the two windows are side by side, and each says where it is', apart,
  `${JSON.stringify(leftAt)} ${JSON.stringify(rightAt)}`);

if (apart) {
  shot('tabmove-01-two-windows.png');

  const grabbed = tabAt(leftAt, 1);
  const onto = tabAt(rightAt, 0, 0.85);
  xdotool('windowactivate', windowNamed('left') || '0');
  await sleep(800);
  drag(grabbed, onto, { held: () => shot('tabmove-02-held-over-another-window.png') });
  await sleep(2500);

  const moved = await whereIs(dragMe);
  check('the dragged tab is in the window it was dropped on', moved?.container === right.container,
    JSON.stringify(moved));
  check('after the tab it was dropped behind', moved?.index === 1 && moved?.of === 2, JSON.stringify(moved));
  check('the window it came from still has its own', (await whereIs(left.sessions[0]?.id))?.of === 1,
    JSON.stringify(left.ids()));
  check('both windows are still on screen', windowCount() === 2, wmctrl('-l'));
  shot('tabmove-03-moved-between-windows.png');

  console.log('\n6. a tab dragged out where no window is');

  await sleep(1500);
  const pullOut = tabAt(rightAt, 1);
  xdotool('windowactivate', windowNamed('right') || '0');
  await sleep(800);

  drag(pullOut, DESKTOP, { abandon: true });
  await sleep(3000);
  const afterEscape = await whereIs(dragMe);
  check('a drag abandoned with Escape leaves the tab where it was',
    afterEscape?.container === right.container && windowCount() === 2,
    `${JSON.stringify(afterEscape)} :: ${wmctrl('-l')}`);

  drag(pullOut, DESKTOP);
  await sleep(14000);

  const popped = await whereIs(dragMe);
  check('the tab is in a window of its own',
    !!popped && popped.of === 1 && popped.container !== right.container && popped.container !== left.container,
    JSON.stringify(popped));
  check('and that window is on screen', windowCount() === 3, wmctrl('-l'));

  const pulledTo = popped ? await viewport(popped.container, { x: DESKTOP.x - 60, y: DESKTOP.y - 16 }) : null;
  check('it came up where the tab was let go', !!pulledTo,
    `${JSON.stringify(savedState().containers.map((c) => c.geometry))} for a drop at ${DESKTOP.x},${DESKTOP.y}`);
  shot('tabmove-04-pulled-into-its-own-window.png');
}

left.ws.close();
right.ws.close();
await sleep(500);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
