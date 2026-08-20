/*
 * A tab moves between windows, and out into one of its own.
 *
 * Dragging a tab from one clio window to another is the same trick the whole
 * daemon rests on, turned sideways: the shell was never the window's, so handing
 * a tab over is a change of which page draws it and nothing else. The process is
 * not signalled, not re-opened, and not told. What this file is here to prove is
 * that the *shell* comes across — the same pty, the same history, still typeable
 * — and that the window it left stops being able to reach it.
 *
 * Two halves. The first drives the daemon over a socket, the way a page does,
 * and covers what the rules are. The second is the real thing: two clio windows
 * on a display of this test's own and a real mouse drag between them, because
 * the first half cannot tell whether a person could do any of it.
 *
 *   node test/tabmove.mjs
 */
import { mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync, execSync, spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Nothing this test opens may land on the desktop of whoever is running it: a
// window somebody else is clicking on is a window this test's mouse drags fight
// with, and the failure looks for all the world like a bug in clio. Dropped
// before anything can inherit it, and handed back only as a display of our own.
delete process.env.DISPLAY;
delete process.env.WAYLAND_DISPLAY;

// And a clio of this run's own. This file starts and stops daemons; pointing one
// at somebody's real shells would take them down with it.
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

/** Everything this file spawned, so it kills those and nothing else. */
const started = [];

process.on('exit', () => {
  try {
    execFileSync(join(ROOT, 'bin', 'clio'), ['stop'], { stdio: 'ignore' });
  } catch {
    /* never started, or already down */
  }
  while (started.length) {
    try {
      started.pop().kill();
    } catch {
      /* already gone */
    }
  }
  try {
    rmSync(SANDBOX, { recursive: true, force: true });
  } catch {
    /* leave it, it is in /tmp */
  }
});

/** A display of this test's own, or null if the machine cannot provide one. */
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
    if (xvfb.exitCode !== null) continue; // that number was taken after all

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

/** Which window a tab is in, and where in the row, as the daemon has it. */
async function whereIs(id) {
  const { containers } = await status();
  for (const container of containers) {
    const index = container.sessions.findIndex((s) => s.id === id);
    if (index !== -1) return { container: container.id, index, of: container.sessions.length };
  }
  return null;
}

/**
 * A page, played by a socket. Everything a window sends, this can send, which is
 * the point: the rules being tested are the daemon's.
 */
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
  /** Open a tab and wait for the daemon to name it. */
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

/* ------------------------------------------- 1. the rules, over the socket */

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

// Something in the moving tab's history, written before it goes anywhere. The
// shell is what is being moved; this is how we know it is the same one.
alpha.send({ t: 'attach', id: going, cols: 80, rows: 24 });
await sleep(500);
alpha.send({ t: 'input', id: going, data: 'echo BEFORE-THE-MOVE\r' });
await sleep(1200);

// Dropped on the far window's strip, in front of the tab already there.
beta.send({ t: 'adopttab', id: going, ids: [going, theirs] });
await sleep(1000);

const landed = await whereIs(going);
check('the tab is in the window it was dropped on', landed?.container === beta.container,
  JSON.stringify(landed));
check('and in the place it was dropped', landed?.index === 0 && landed?.of === 2, JSON.stringify(landed));
check('the window it left has only its own tabs', (await whereIs(keep))?.of === 1);
check('the window it left was told', !alpha.ids().includes(going), JSON.stringify(alpha.ids()));
check('the window that took it was told', beta.ids().includes(going), JSON.stringify(beta.ids()));

// The same shell, with everything that was in it: what the new window is handed
// when it puts the tab on screen is the pty's own history.
beta.send({ t: 'attach', id: going, cols: 100, rows: 30 });
await sleep(800);
check('the scrollback came with it', /BEFORE-THE-MOVE/.test(beta.replayed || ''),
  JSON.stringify((beta.replayed || '').slice(-80)));

// And it is still a shell, taking input from where it is now.
beta.send({ t: 'input', id: going, data: 'echo AFTER-THE-MOVE\r' });
await sleep(1500);
check('the shell is still running and answers the new window',
  /AFTER-THE-MOVE/.test(beta.output.get(going) || ''),
  JSON.stringify((beta.output.get(going) || '').slice(-80)));

// The window it left must not be able to reach it any more — that is the whole
// of what a container is for, and a stale id in a page that has not caught up
// yet is the ordinary way it gets tested.
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

// The window is left with nothing in it. A page would close itself; the window
// as far as the daemon is concerned simply stops existing, rather than being
// kept as something to open again — there is nothing in it to keep.
beta.send({ t: 'adopttab', id: keep, ids: [keep, going, theirs] });
await sleep(1000);
const containers = (await status()).containers.map((c) => c.id);
check('the emptied window is gone', !containers.includes(alpha.container), JSON.stringify(containers));
check('all three tabs are in the one window',
  (await whereIs(keep))?.of === 3 && (await whereIs(going))?.container === beta.container);
check('in the order they were dropped in',
  (await whereIs(keep))?.index === 0 && (await whereIs(going))?.index === 1,
  JSON.stringify(await whereIs(going)));

// Written down, not just remembered: a tab moved between windows has to still
// be in its new one after a reboot, which is the whole promise clio makes about
// everything else.
await sleep(1200);
const onDisk = savedState().sessions.find((s) => s.id === going);
check('the move is on disk', onDisk?.container === beta.container, JSON.stringify(onDisk?.container));

console.log('\n4. a tab pulled out into a window of its own');

// Without a display there is no browser to put a window on, and poptab is a
// window being opened. The rule that does not need one is the refusal.
const lonely = await connect();
await sleep(400);
const only = await lonely.open();
await sleep(500);
lonely.send({ t: 'poptab', id: only, geometry: { x: 100, y: 100, width: 900, height: 600 } });
await sleep(1200);
check('the only tab in a window stays where it is', (await whereIs(only))?.container === lonely.container,
  JSON.stringify(await whereIs(only)));

// End it rather than just dropping the socket. A window's worth of tabs with
// nobody looking at them is a window that was closed, and the section below
// wants a plain window rather than one that opens onto the picker offering it.
lonely.send({ t: 'close', id: only });
await sleep(800);
lonely.ws.close();
alpha.ws.close();
await sleep(500);

/* ------------------------------------------------- 5. a real mouse, real windows */

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
  wmctrl('-l').trim().split('\n').find((line) => line.includes(`${name} · clio`))?.split(/\s+/)[0] || null;

/*
 * Both windows are put where this test wants them, at a size it chose.
 *
 * Chrome honours --window-position for the first window of its browser process
 * and ignores it for every one after, so two windows asked for in a row arrive
 * exactly on top of each other — which is fine for a person, who moves one, and
 * useless here: a drag between two windows in the same place proves nothing.
 * Side by side with room underneath, so "outside every window" is a real place.
 */
const PLACE = {
  left: { x: 0, y: 0, w: 700, h: 450 },
  right: { x: 760, y: 0, w: 700, h: 450 },
};
/*
 * Where a tab is let go with no window under it: below both of them, and far
 * enough from the bottom edge that the window it turns into fits on the screen.
 * A drop too near the edge is placed as well as it can be rather than where it
 * was asked for — the desktop keeps a window on itself — and this is about
 * whether the right place was asked for at all.
 */
const DESKTOP = { x: 900, y: 560 };

function place(name, at) {
  const win = windowNamed(name);
  if (!win) return false;
  wmctrl('-i', '-r', win, '-e', `0,${at.x},${at.y},${at.w},${at.h}`);
  return true;
}

/**
 * Which windows have a page connected to them, waiting for one to arrive.
 *
 * Worth waiting for rather than assuming: everything below is coordinates on a
 * window, and a probe that connects before the real page has means the daemon
 * hands it a container of its own — an empty one, with no window anywhere, that
 * answers every question in this section plausibly and wrongly.
 */
async function onScreen(count) {
  for (let i = 0; i < 60; i++) {
    const shown = (await status()).containers.filter((c) => c.onScreen);
    if (shown.length >= count && windowCount() >= count) return shown;
    await sleep(500);
  }
  return [];
}

// Tidy: this section wants two plain windows and nothing else, and the half
// above has left a window's worth of tabs with a socket watching them.
for (const id of beta.ids()) beta.send({ t: 'close', id });
await sleep(1500);
beta.ws.close();
await sleep(1500);

/*
 * Nothing may be left over by the time a window is asked for.
 *
 * Two things go wrong otherwise, and both look like something else. A window
 * that opens while a closed one is waiting opens onto the picker — and a page on
 * the picker has no tab row and does not even say where it is, so every
 * coordinate below would be measuring an overlay. And a container still being
 * watched by a socket from up there counts as a window on screen, which is how a
 * probe ends up attached to a set of tabs that no window is showing: every
 * question answered plausibly, about the wrong thing.
 */
const over = (await status()).containers;
check('nothing is left over from the sections above', !over.length, JSON.stringify(over));

// The daemon has to be told about the display: it was started from a shell that
// had none, which is the position a daemon launched by a desktop is in once the
// session it was launched from goes away.
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

/*
 * Short names for the tabs, so where they are is arithmetic rather than a guess.
 *
 * A tab is as wide as its label up to a limit, and these are named after a
 * directory — the path this test happens to be run from, which can be anything
 * at all. Renamed, every one of them comes to the same minimum width, and the
 * nth tab is n of those along from the left edge of the page.
 */
const TABBAR_HEIGHT = 32; // --tabbar-height in src/ui/style.css
const TAB_WIDTH = 90; // .tab's min-width, which is what a two-letter label comes to
left.sessions.forEach((s, i) => left.send({ t: 'rename', id: s.id, title: `L${i + 1}` }));
right.sessions.forEach((s, i) => right.send({ t: 'rename', id: s.id, title: `R${i + 1}` }));
await sleep(1000);

const placedLeft = place('left', PLACE.left);
const placedRight = place('right', PLACE.right);
check('both windows can be found by name and moved', placedLeft && placedRight, wmctrl('-l'));

/*
 * Where a window's page actually is, which is what every coordinate below is
 * measured from.
 *
 * Not from the window manager: `wmctrl -lG` reports the frame, and the offset
 * between the frame and the page inside it belongs to whatever theme is
 * running. The page itself knows — window.screenX/Y is the top left of the
 * viewport — and tells the daemon, which writes it down. So this reads it out of
 * the daemon's own state file, and waits until what is written is where the
 * window was just put: that wait is also how this knows the move landed.
 */
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

/** The middle of the nth tab in a window whose page is at `geometry`. */
function tabAt(geometry, index, fraction = 0.5) {
  if (!geometry) return null;
  return {
    x: Math.round(geometry.x + (index + fraction) * TAB_WIDTH),
    y: Math.round(geometry.y + TABBAR_HEIGHT / 2),
  };
}

/**
 * A real drag: press, walk the pointer across in steps, let go.
 *
 * `held` runs with the button still down and the pointer at its destination,
 * which is the only moment the page can be caught showing what a drop would do.
 * `abandon` presses Escape there instead of letting go, the way a person changes
 * their mind halfway.
 */
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
    /* a picture is a nicety */
  }
}

// Both pages say where they are, and it is where they were put — without which
// every coordinate below is pointing at the wrong window, or at both.
const leftAt = await viewport(left.container, PLACE.left);
const rightAt = await viewport(right.container, PLACE.right);
const apart = !!leftAt && !!rightAt && rightAt.x - leftAt.x > 300;
check('the two windows are side by side, and each says where it is', apart,
  `${JSON.stringify(leftAt)} ${JSON.stringify(rightAt)}`);

if (apart) {
  shot('tabmove-01-two-windows.png');

  // The second of the left window's two tabs, onto the right half of the only
  // tab in the other window — so it lands after it, which is a place a drop has
  // to be able to choose.
  const grabbed = tabAt(leftAt, 1);
  const onto = tabAt(rightAt, 0, 0.85);
  xdotool('windowactivate', windowNamed('left') || '0');
  await sleep(800);
  // The picture is taken with the tab still in the air, over the row that is
  // about to take it: the mark showing where it would land is the only thing
  // telling the person this is going to work, and it is on screen for exactly
  // as long as the button is down.
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

  /* ----------------------------- 6. and out onto the desktop, into its own */

  console.log('\n6. a tab dragged out where no window is');

  await sleep(1500);
  const pullOut = tabAt(rightAt, 1);
  xdotool('windowactivate', windowNamed('right') || '0');
  await sleep(800);

  /*
   * Changing your mind: the same drag, abandoned with Escape where it would
   * otherwise have become a window.
   *
   * Worth a test of its own because the page has so little to go on. The browser
   * never delivers the keypress that cancelled the drag, and what it does say —
   * dropEffect — describes the last thing the pointer crossed rather than
   * whether anything took the tab. If this ever stops working, Escape becomes a
   * way of getting a window you were trying not to make.
   */
  drag(pullOut, DESKTOP, { abandon: true });
  await sleep(3000);
  const afterEscape = await whereIs(dragMe);
  check('a drag abandoned with Escape leaves the tab where it was',
    afterEscape?.container === right.container && windowCount() === 2,
    `${JSON.stringify(afterEscape)} :: ${wmctrl('-l')}`);

  drag(pullOut, DESKTOP);
  // A browser has to start and a window has to come up, which is slower than
  // anything else here by an order of magnitude.
  await sleep(14000);

  const popped = await whereIs(dragMe);
  check('the tab is in a window of its own',
    !!popped && popped.of === 1 && popped.container !== right.container && popped.container !== left.container,
    JSON.stringify(popped));
  check('and that window is on screen', windowCount() === 3, wmctrl('-l'));

  // Where it came up. A window pulled out of another should arrive under the
  // cursor that pulled it rather than wherever the browser felt like — the
  // pointer is the only thing the person doing it was aiming with.
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
