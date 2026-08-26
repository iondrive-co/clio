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
 * A page saying it is on its way out, the way a real one does — sendBeacon to
 * /gone as it is taken apart. It is the whole of the difference between a window
 * somebody closed and a page that was killed, so a test about that difference
 * has to be able to say it.
 */
async function goodbye(container) {
  const { port, token } = handshake();
  await fetch(`http://127.0.0.1:${port}/gone?c=${container}&token=${token}`, { method: 'POST' });
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

/* ------------------------- 5. a place the window cannot get to on its own */

/*
 * The monitor a window was on is the half of "where it was" that a page cannot
 * do anything about. A browser answers a move that would take a window off the
 * display it is on by moving it as far as that display allows and stopping
 * there — so a window whose place is on the next screen along comes back the
 * right size against the wrong edge, and then reports that edge as though
 * somebody had chosen it, which is how a desktop collapses onto one monitor a
 * restore at a time.
 *
 * One display is all a test machine has, so the stand-in for another monitor is
 * a position on this one that a page is refused in exactly the same way: half
 * off the right-hand edge. Nothing the page can do puts a window there. The
 * daemon can, through the window manager, and that is what this checks.
 */
console.log('\n5. a window comes back somewhere its page could never move it');

const overhang = { x: 1500, y: 300, w: 700, h: 480 };
check(
  'the target really is out of the page\u2019s reach',
  overhang.x + overhang.w > 1920,
  `${overhang.x} + ${overhang.w} against a 1920-wide screen`,
);

const onScreen = windows();
wmctrl('-i', '-r', onScreen[0].id, '-e', `0,${overhang.x},${overhang.y},${overhang.w},${overhang.h}`);
await sleep(3500);
const hanging = windows().find((win) => Math.abs(win.x - overhang.x) <= 4);
check('it is hanging off the edge now', !!hanging, JSON.stringify(windows()));
const savedOverhang = savedState().containers.find((c) => c.geometry && Math.abs(c.geometry.x - overhang.x) <= 4);
check('and the daemon wrote that down', !!savedOverhang, JSON.stringify(savedState().containers.map((c) => c.geometry)));

process.kill(handshake().pid, 'SIGKILL');
await sleep(2000);
for (const win of windows()) wmctrl('-i', '-c', win.id);
await sleep(2000);
clio('start');
await sleep(1500);
clio();
await sleep(14000);

const afterOverhang = windows();
const overhangBack = afterOverhang.find((win) => Math.abs(win.x - overhang.x) <= 6);
check(
  'it came back where it was, off the edge and all',
  !!overhangBack,
  JSON.stringify(afterOverhang),
);
check(
  'no window is left wearing the name the daemon looked for it by',
  !wmctrl('-l').includes('putting this window back'),
  wmctrl('-l').trim(),
);
// The point of the whole exercise: what is on file is still where the window
// belongs, not the edge the browser would only let it get to.
const overhangOnFile = savedState().containers.find((c) => c.geometry && Math.abs(c.geometry.x - overhang.x) <= 6);
check('and the position on file was not overwritten on the way', !!overhangOnFile, JSON.stringify(savedState().containers.map((c) => c.geometry)));

/* --------------------------- 6. what the picker is for, and what it is not */

/*
 * A window that was closed and a window whose page was killed leave the daemon
 * in the same position — a socket gone and nothing coming back — and need
 * opposite answers. One is somebody putting a window away, and belongs in the
 * list `clio` offers by name. The other is a window nobody closed, and the only
 * right answer is to put it back the way it was.
 *
 * The difference is the goodbye a page sends as it is taken apart, and these two
 * sections are the difference: same socket dropping, one with it and one
 * without.
 */
console.log('\n6. a page that was killed is still a window that is open');

const killedPage = await connect('');
await sleep(500);
killedPage.send({ t: 'create', cwd: process.env.HOME, cols: 80, rows: 24 });
await sleep(1500);
const killedId = killedPage.container;
// No goodbye: this is a renderer the system took, with nothing left of it to
// say anything.
killedPage.ws.close();
await sleep(12000);

let listed = (await status()).containers.find((c) => c.id === killedId);
check('it is not offered as one of the closed windows', listed && !listed.saved, JSON.stringify(listed));
check('so clio has nothing to ask about', clio('windows').includes('No closed windows'), clio('windows').trim());

console.log('\n7. a window somebody closed is offered by name, as before');

const closedPage = await connect('');
await sleep(500);
closedPage.send({ t: 'create', cwd: process.env.HOME, cols: 80, rows: 24 });
await sleep(1500);
const closedId = closedPage.container;
await goodbye(closedId);
closedPage.ws.close();
await sleep(12000);

listed = (await status()).containers.find((c) => c.id === closedId);
check('it is in the list', listed && listed.saved, JSON.stringify(listed));

/* ------------------------------ 8. the browser going down under all of them */

/*
 * Every clio window is a page in one browser process. When that process goes —
 * a crash, an update restarting it, the desktop being shut down under it —
 * every window is taken apart at once, and each says goodbye on the way out
 * exactly as it would if somebody had clicked its close button. Nobody closed
 * any of them, and this is the event that used to turn a reboot into a list of
 * names to choose from: four windows, four goodbyes, four entries in the picker.
 *
 * One at a time they cannot be told apart from a close. Together they can.
 */
console.log('\n8. every window going at once is the browser, not a decision');

const together = [];
for (const _ of [1, 2]) {
  const client = await connect('');
  await sleep(500);
  client.send({ t: 'create', cwd: process.env.HOME, cols: 80, rows: 24 });
  await sleep(1500);
  together.push(client);
}
// Both at once, the way a browser being taken down does it.
for (const client of together) await goodbye(client.container);
for (const client of together) client.ws.close();
await sleep(12000);

const afterBrowser = await status();
for (const [index, client] of together.entries()) {
  const seen = afterBrowser.containers.find((c) => c.id === client.container);
  check(
    `window ${index + 1} of the pair was left open, not put away`,
    seen && !seen.saved && seen.sessions.length > 0,
    JSON.stringify(seen),
  );
}
/* ------------------------------- 9. the desktop going down under a window */

/*
 * The second half of the same thing, from the other side: a close that is still
 * inside its grace period when the daemon is told to stop. Nothing about it has
 * been decided, and the way out of the process is not the place to decide it —
 * so it is left as a window that was open, and `clio` puts it back.
 *
 * A close that had already run its course is untouched, which is the other half
 * of the check.
 */
console.log('\n9. a shutdown keeps what was still undecided');

const goingDown = await connect('');
await sleep(500);
goingDown.send({ t: 'create', cwd: process.env.HOME, cols: 80, rows: 24 });
await sleep(1500);
const goingId = goingDown.container;
await goodbye(goingId);
goingDown.ws.close();
await sleep(1000);
clio('stop');
await sleep(3000);

const onDisk = savedState().containers;
check(
  'a close still in its grace period is left open, so clio puts it back',
  onDisk.find((c) => c.id === goingId)?.closedAt === null,
  JSON.stringify(onDisk.find((c) => c.id === goingId)),
);
check(
  'and one closed long enough ago to have settled stays closed',
  onDisk.find((c) => c.id === closedId)?.closedAt !== null,
  JSON.stringify(onDisk.find((c) => c.id === closedId)),
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
