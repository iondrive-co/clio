import { mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync, execSync, spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

delete process.env.DISPLAY;
delete process.env.WAYLAND_DISPLAY;

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

async function goodbye(container) {
  const { port, token } = handshake();
  await fetch(`http://127.0.0.1:${port}/gone?c=${container}&token=${token}`, { method: 'POST' });
}

async function connect(container) {
  const { port, token } = handshake();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}&c=${container}`, {
    origin: `http://127.0.0.1:${port}`,
  });
  const client = { ws, sessions: [], container: null };
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.t === 'sessions') {
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

console.log('\n1. a tab is named after what is running in it, unopened');

const client = await connect('');
await sleep(500);

client.send({ t: 'create', cwd: process.env.HOME, cols: 80, rows: 24 });
await sleep(1500);
const tab = client.created;
check('a tab was made', !!tab, JSON.stringify(client.sessions.map((s) => s.id)));

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
afterReload.send({ t: 'close', id: tab.id });
await sleep(1000);
afterReload.ws.close();
client.ws.close();
await sleep(1500);

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

clio();
await sleep(7000);
check('a window is on screen', windows().length === 1, JSON.stringify(windows()));

const showing = (await status()).containers.find((c) => c.sessions.length)?.id;
check('and it is a window with tabs, not the picker', !!showing, JSON.stringify(await status()));
const page = await connect(showing);
page.send({ t: 'newwindow', cwd: process.env.HOME });
await sleep(9000);
page.ws.close();

const two = windows();
check('a second window opened', two.length === 2, JSON.stringify(two));
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
const overhangOnFile = savedState().containers.find((c) => c.geometry && Math.abs(c.geometry.x - overhang.x) <= 6);
check('and the position on file was not overwritten on the way', !!overhangOnFile, JSON.stringify(savedState().containers.map((c) => c.geometry)));

console.log('\n6. a page that was killed is still a window that is open');

const killedPage = await connect('');
await sleep(500);
killedPage.send({ t: 'create', cwd: process.env.HOME, cols: 80, rows: 24 });
await sleep(1500);
const killedId = killedPage.container;
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

console.log('\n8. every window going at once is the browser, not a decision');

const together = [];
for (const _ of [1, 2]) {
  const client = await connect('');
  await sleep(500);
  client.send({ t: 'create', cwd: process.env.HOME, cols: 80, rows: 24 });
  await sleep(1500);
  together.push(client);
}
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
