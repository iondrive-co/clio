/*
 * A window comes back as it was, and a tab knows what is in it before anybody
 * clicks on it.
 *
 * Both of these are about the state of a desktop rather than the state of a
 * shell, and both were wrong in the same way: the only thing that knew was the
 * page, and a page exists for one window, on one monitor, for as long as that
 * window is open.
 *
 *   1. The title a program announces. It arrives as an escape sequence in the
 *      output, so the browser learns it by parsing the stream — for the one tab
 *      it has a terminal for. Every other tab in the row was named after the
 *      command instead, which after a restore means thirteen tabs called
 *      `claude`. The daemon reads them too now, for all of them.
 *
 *   2. Where the window is. Chrome honours --window-size and --window-position
 *      for the first window of its browser process and quietly ignores them for
 *      every one after, so a morning that opens four windows gets one where it
 *      was asked and three stacked on top of it. The page puts itself in place
 *      instead, and tells the daemon where it ends up.
 *
 * Runs a clio of its own, on its own state, on a display of its own making:
 *
 *   node test/windows.mjs
 */
import { mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync, execSync, spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// No window this test opens may land on the desktop of whoever is running it: a
// window somebody else is clicking on does not move when wmctrl asks it to, and
// the failure that follows looks like a bug in clio. Dropped here, before
// anything can inherit it, and handed back only as a display of our own.
delete process.env.DISPLAY;
delete process.env.WAYLAND_DISPLAY;

// And a clio of this run's own, from the first line to the last: it kills a
// daemon outright further down, which is fatal to whatever shells that daemon
// happens to be holding.
const SANDBOX = mkdtempSync(join(tmpdir(), 'clio-windows-'));
process.env.XDG_RUNTIME_DIR = join(SANDBOX, 'run');
process.env.XDG_STATE_HOME = join(SANDBOX, 'state');
process.env.CLIO_DEV = '1';
mkdirSync(process.env.XDG_RUNTIME_DIR, { recursive: true });
mkdirSync(process.env.XDG_STATE_HOME, { recursive: true });

const HANDSHAKE = join(process.env.XDG_RUNTIME_DIR, 'clio', 'daemon.json');
const STATE_FILE = join(process.env.XDG_STATE_HOME, 'clio', 'state.json');

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

/**
 * A second view of one window's tabs, which is how this test plays the part of a
 * page without opening one.
 */
async function connect(container) {
  const { port, token } = handshake();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}&c=${container}`, {
    origin: `http://127.0.0.1:${port}`,
  });
  const client = { ws, sessions: [], container: null };
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.t === 'sessions') {
      // The daemon has the last word on which container this is; asking for none
      // is how a fresh window is given one.
      client.container = msg.container;
      client.sessions = msg.sessions;
    }
    if (msg.t === 'created') client.created = msg.session;
  });
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  client.send = (msg) => ws.send(JSON.stringify(msg));
  client.tab = (id) => client.sessions.find((s) => s.id === id);
  return client;
}

console.log(`clio window test — sandbox at ${SANDBOX}`);
console.log(clio('start').trim());
await sleep(500);

/* ------------------------------------------- 1. the title a program announces */

console.log('\n1. a tab is named after what is running in it, unopened');

const client = await connect('');
await sleep(500);

// A daemon with nothing in it: make the tab this test needs. Nothing attaches to
// it and no window is showing it, which is the whole point — this is the tab that
// used to come back called `claude`.
client.send({ t: 'create', cwd: process.env.HOME, cols: 80, rows: 24 });
await sleep(1500);
const tab = client.created;
check('a tab was made', !!tab, JSON.stringify(client.sessions.map((s) => s.id)));

// What Claude Code does, minus Claude Code: announce a title and stay in the
// foreground. The prompt is deliberately not allowed to come back — a shell sets
// a title of its own the moment it does, which is the one thing an agent at work
// never does.
client.send({
  t: 'input',
  id: tab.id,
  data: `printf '\\033]0;✳ Fixing the parser\\007'; sleep 120\r`,
});
await sleep(4500);

check(
  'the daemon read the title out of the stream',
  client.tab(tab.id)?.termTitle === '✳ Fixing the parser',
  JSON.stringify(client.tab(tab.id)?.termTitle),
);
check(
  'and it is not written down, because it belongs to a process',
  savedState().sessions.every((s) => s.termTitle === undefined),
  JSON.stringify(savedState().sessions),
);

console.log('\n2. and it is still there when the daemon is replaced');
clio('reload');
await sleep(5000);
const afterReload = await connect(client.container);
await sleep(2500);
check(
  'the title came across the handover',
  afterReload.tab(tab.id)?.termTitle === '✳ Fixing the parser',
  JSON.stringify(afterReload.tab(tab.id)?.termTitle),
);
// End that tab before going on. A set of tabs left with nobody looking at them
// is a window that was closed, and `clio` would offer it in the picker rather
// than opening the plain window the next section is about.
afterReload.send({ t: 'close', id: tab.id });
await sleep(1000);
afterReload.ws.close();
client.ws.close();
await sleep(1500);

/* ---------------------------------------------------- 3. where a window sits */

const display = await startDisplay();
if (!display) {
  console.log('\n3. windows — skipped: this machine has no Xvfb and window manager');
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
process.env.DISPLAY = display;
console.log(`\n3. two windows, on display ${display}`);

const wmctrlThere = installed('wmctrl');
if (!wmctrlThere) {
  console.log('   skipped: wmctrl is not installed, and nothing else can move a window');
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

const wmctrl = (...args) => execFileSync('wmctrl', args, { encoding: 'utf8', env: process.env });
const windows = () =>
  wmctrl('-lG')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id, , x, y, w, h] = line.split(/\s+/);
      return { id, x: Number(x), y: Number(y), w: Number(w), h: Number(h) };
    })
    .sort((a, b) => a.x - b.x || a.y - b.y);

// The daemon has to be told about the display: it was started from a shell that
// had none, which is exactly the position a daemon started by a desktop launcher
// is in when the session it was launched from goes away.
clio();
await sleep(7000);
check('a window is on screen', windows().length === 1, JSON.stringify(windows()));

const showing = (await status()).containers.find((c) => c.sessions.length)?.id;
// It has to be a window with a shell in it, not the picker: a frame that has not
// been told what it is showing yet deliberately does not report where it is.
check('and it is a window with tabs, not the picker', !!showing, JSON.stringify(await status()));
const page = await connect(showing);
page.send({ t: 'newwindow', cwd: process.env.HOME });
await sleep(9000);
page.ws.close();

const two = windows();
check('a second window opened', two.length === 2, JSON.stringify(two));
// Not an assertion, a demonstration: the browser puts the second window exactly
// where it put the first, whatever it was told.
console.log(`   the browser left them at ${two.map((w) => `${w.x},${w.y} ${w.w}x${w.h}`).join(' | ')}`);

const want = [
  { x: 80, y: 100, w: 700, h: 480 },
  { x: 960, y: 420, w: 820, h: 560 },
];
two.forEach((win, i) => wmctrl('-i', '-r', win.id, '-e', `0,${want[i].x},${want[i].y},${want[i].w},${want[i].h}`));
await sleep(3500);
const placed = windows();
console.log(`   moved to ${placed.map((w) => `${w.x},${w.y} ${w.w}x${w.h}`).join(' | ')}`);
check(
  'both windows are where this test put them',
  placed.length === 2 && placed.every((win, i) => Math.abs(win.w - want[i].w) <= 4),
  JSON.stringify(placed),
);

const geometries = savedState().containers.map((c) => c.geometry);
check(
  'the daemon wrote down where each window is',
  geometries.length === 2 && geometries.every((g) => g && g.width > 0),
  JSON.stringify(geometries),
);

console.log('\n4. the daemon is killed outright, and clio puts the desktop back');
process.kill(handshake().pid, 'SIGKILL');
await sleep(2000);
for (const win of placed) wmctrl('-i', '-c', win.id);
await sleep(2000);
clio('start');
await sleep(1500);
clio();
await sleep(13000);

const back = windows();
check('both windows came back', back.length === 2, JSON.stringify(back));
console.log(`   came back at ${back.map((w) => `${w.x},${w.y} ${w.w}x${w.h}`).join(' | ')}`);

const near = (a, b) => Math.abs(a - b) <= 4;
placed.forEach((was, i) => {
  const now = back[i];
  check(
    `window ${i + 1} is the size it was, where it was`,
    !!now && near(now.x, was.x) && near(now.y, was.y) && near(now.w, was.w) && near(now.h, was.h),
    `${now ? `${now.x},${now.y} ${now.w}x${now.h}` : 'missing'} vs ${was.x},${was.y} ${was.w}x${was.h}`,
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
