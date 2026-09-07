import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { execFileSync, execSync, spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

delete process.env.DISPLAY;
delete process.env.WAYLAND_DISPLAY;

const SANDBOX = mkdtempSync(join(tmpdir(), 'clio-displays-'));
process.env.XDG_RUNTIME_DIR = join(SANDBOX, 'run');
process.env.XDG_STATE_HOME = join(SANDBOX, 'state');
process.env.CLIO_DEV = '1';
mkdirSync(process.env.XDG_RUNTIME_DIR, { recursive: true });
mkdirSync(process.env.XDG_STATE_HOME, { recursive: true });

const HANDSHAKE = join(process.env.XDG_RUNTIME_DIR, 'clio', 'daemon.json');

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

const started = [];

process.on('exit', () => {
  try {
    execFileSync(join(ROOT, 'bin', 'clio'), ['stop'], { stdio: 'ignore', env: process.env });
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

const SHIMDIR = join(SANDBOX, 'bin');
const WINDOWS = join(SANDBOX, 'windows');
mkdirSync(SHIMDIR, { recursive: true });
mkdirSync(WINDOWS, { recursive: true });

writeFileSync(
  join(SHIMDIR, 'window.cjs'),
  `const fs = require('fs');
const path = require('path');
const WebSocket = require(${JSON.stringify(join(ROOT, 'node_modules', 'ws'))});

const app = process.argv.find((a) => a.startsWith('--app='));
if (!app) process.exit(1);
const url = new URL(app.slice('--app='.length));
const dir = process.env.CLIO_TEST_WINDOWS;
const record = path.join(dir, process.pid + '.json');

fs.writeFileSync(record, JSON.stringify({
  pid: process.pid,
  display: url.searchParams.get('d') || null,
  container: url.searchParams.get('c') || null,
  pick: url.searchParams.get('pick') === '1',
  profile: (process.argv.find((a) => a.startsWith('--user-data-dir=')) || '').split('=')[1] || null,
}));

// However this process ends — the socket closing under it, or the test taking
// the window off the screen with a signal — the record has to go with it, or a
// window that is not there is still counted as one on that display.
process.on('exit', () => { try { fs.unlinkSync(record); } catch {} });
process.on('SIGTERM', () => process.exit(0));
process.on('SIGHUP', () => process.exit(0));
const gone = () => process.exit(0);

const ws = new WebSocket('ws://' + url.host + '/' + url.search, {
  origin: 'http://' + url.host,
});
ws.on('message', (raw) => {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  if (msg.t === 'moved') {
    fs.appendFileSync(path.join(dir, 'moved.log'), url.searchParams.get('c') + ' ' + msg.display + '\\n');
    try { ws.close(); } catch {}
    gone();
  }
});
ws.on('close', gone);
ws.on('error', gone);
`,
);
writeFileSync(join(SHIMDIR, 'chromium'), `#!/bin/sh\nexec node ${join(SHIMDIR, 'window.cjs')} "$@"\n`);
chmodSync(join(SHIMDIR, 'chromium'), 0o755);

function shimWindows(display = null) {
  const out = [];
  for (const name of readdirSync(WINDOWS)) {
    if (!name.endsWith('.json')) continue;
    try {
      const record = JSON.parse(readFileSync(join(WINDOWS, name), 'utf8'));
      if (display === null || record.display === display) out.push(record);
    } catch {
    }
  }
  return out;
}

function closeWindow(record) {
  try {
    process.kill(record.pid);
  } catch {
  }
}

const movedLog = () => {
  const file = join(WINDOWS, 'moved.log');
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : [];
};

const clio = (display, ...args) => {
  try {
    return execFileSync(join(ROOT, 'bin', 'clio'), args, {
      encoding: 'utf8',
      env: {
        ...process.env,
        DISPLAY: display,
        PATH: `${SHIMDIR}:${process.env.PATH}`,
        CLIO_TEST_WINDOWS: WINDOWS,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    return `${err.stdout || ''}${err.stderr || ''}`;
  }
};

const handshake = () => JSON.parse(readFileSync(HANDSHAKE, 'utf8'));

async function status() {
  const { port, token } = handshake();
  const res = await fetch(`http://127.0.0.1:${port}/status?token=${token}`);
  return res.json();
}

const key = (display) => display.replace(/^:/, '');

async function connect(container, display) {
  const { port, token } = handshake();
  const address =
    `ws://127.0.0.1:${port}/?token=${token}&c=${container}` +
    (display ? `&d=${encodeURIComponent(key(display))}` : '');
  const ws = new WebSocket(address, { origin: `http://127.0.0.1:${port}` });
  const heard = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    heard.push(msg);
    if (msg.t === 'moved') ws.close();
  });
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  return {
    ws,
    heard,
    said: (t) => heard.some((msg) => msg.t === t),
    send: (msg) => ws.send(JSON.stringify(msg)),
  };
}

function shells(daemonPid) {
  const out = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    let stat;
    let cmd;
    try {
      stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
      cmd = readFileSync(`/proc/${entry}/cmdline`, 'utf8');
    } catch {
      continue;
    }
    const after = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
    if (Number(after[1]) !== daemonPid) continue;
    if (/chrome|chromium|brave|window\.cjs/.test(cmd)) continue;
    out.push(Number(entry));
  }
  return out.sort((a, b) => a - b);
}

console.log(`clio two-display test — sandbox at ${SANDBOX}`);

const LOCAL = ':81';
const REMOTE = ':82';
const DESK = 'facade';

console.log(`\n1. one daemon, two sessions: ${LOCAL} at the machine, ${REMOTE} over the wire`);
process.env.WAYLAND_DISPLAY = 'wayland-99';
clio(LOCAL, 'start');
await sleep(2500);
delete process.env.WAYLAND_DISPLAY;
const daemon = handshake().pid;

const home = await connect(DESK, LOCAL);
home.send({ t: 'create', cwd: process.env.HOME });
await sleep(2000);

const first = (await status()).containers.find((c) => c.id === DESK);
const tabs = first?.sessions.map((s) => s.id) || [];
check('a window at the machine has a shell in it', tabs.length === 1, JSON.stringify(first));
check(`and the daemon knows it is on ${key(LOCAL)}`, first?.display === key(LOCAL), JSON.stringify(first?.display));

const before = shells(daemon);
check('one shell is running', before.length === 1, JSON.stringify(before));

console.log(`\n2. clio in the session over the wire, the way its autostart runs it`);
console.log(`   ${clio(REMOTE).trim() || '(nothing said)'}`);
await sleep(3000);

const moved = await status();
const now = moved.containers.find((c) => c.id === DESK);
check(
  'the tabs are still one window, not two',
  moved.containers.length === 1,
  JSON.stringify(moved.containers.map((c) => ({ id: c.id, tabs: c.sessions.length }))),
);
check(
  'with the same tabs in it',
  JSON.stringify(now?.sessions.map((s) => s.id)) === JSON.stringify(tabs),
  JSON.stringify(now?.sessions.map((s) => s.id)),
);
check(
  'and the same shell, not restarted',
  JSON.stringify(shells(daemon)) === JSON.stringify(before),
  `${before.join(', ')} → ${shells(daemon).join(', ')}`,
);
check(
  `the window is on ${key(REMOTE)} now, where clio was run`,
  now?.display === key(REMOTE),
  JSON.stringify(now?.display),
);
check(
  'one window on that display',
  shimWindows(key(REMOTE)).length === 1,
  JSON.stringify(shimWindows()),
);
check(
  'and none on the display nobody is at',
  shimWindows(key(LOCAL)).length === 0,
  JSON.stringify(shimWindows()),
);
check(
  'the window it was in was told, and let go',
  home.said('moved') && home.ws.readyState !== WebSocket.OPEN,
);
check('it was not offered as a choice', !shimWindows().some((w) => w.pick) && !moved.containers.some((c) => c.saved));
check(
  'and the browser it came up in is that display’s own, with nothing of the daemon’s in it',
  (shimWindows(key(REMOTE))[0]?.profile || '').endsWith(`browser-profile-${key(REMOTE)}`),
  JSON.stringify(shimWindows(key(REMOTE))[0]?.profile),
);

console.log(`\n3. clio again on ${REMOTE}, where the window already is`);
clio(REMOTE);
await sleep(3000);
const again = shimWindows();
check(
  'no second window onto the same tabs',
  again.filter((w) => w.container === DESK).length === 1,
  JSON.stringify(again),
);
check(
  'and the new one it opened instead is on this display',
  again.length === 2 && again.every((w) => w.display === key(REMOTE)),
  JSON.stringify(again),
);
const spare = again.find((w) => w.container !== DESK);
const spareShell = (await status()).containers.find((c) => c.id === spare?.container)?.sessions[0];
if (spareShell) {
  const page = await connect(spare.container, REMOTE);
  page.send({ t: 'close', id: spareShell.id });
  await sleep(1500);
  page.ws.close();
  closeWindow(spare);
  await sleep(2000);
}

console.log(`\n4. clio open, by name, from the session it is not in`);
const refused = clio(REMOTE, 'open', DESK);
check(
  'asking for it where it already is says so',
  /already open/.test(refused),
  JSON.stringify(refused.trim()),
);
const fetched = clio(LOCAL, 'open', DESK);
await sleep(3000);
const home2 = (await status()).containers.find((c) => c.id === DESK);
check(
  `asking from ${key(LOCAL)} brings it there`,
  home2?.display === key(LOCAL) && shimWindows(key(LOCAL)).length === 1,
  `${JSON.stringify(home2?.display)} ${JSON.stringify(shimWindows())} ${fetched.trim()}`,
);
check(
  'and nothing is showing it over the wire any more',
  !shimWindows(key(REMOTE)).some((w) => w.container === DESK),
  JSON.stringify(shimWindows()),
);
check(
  'the shell has been through both moves untouched',
  JSON.stringify(shells(daemon)) === JSON.stringify(before),
  `${before.join(', ')} → ${shells(daemon).join(', ')}`,
);
console.log(`   windows told they had moved: ${JSON.stringify(movedLog())}`);

console.log(`\n5. a window that was closed is still a choice, not a move`);
const parked = shimWindows().find((w) => w.container === DESK);
const { port, token } = handshake();
await fetch(`http://127.0.0.1:${port}/gone?c=${DESK}&token=${token}`, { method: 'POST' });
closeWindow(parked);
await sleep(13000);
const away = (await status()).containers.find((c) => c.id === DESK);
check('it was put away under a name', !!away?.saved, JSON.stringify({ away, parked }));
check(
  'and nothing is showing it',
  !away?.onScreen && !shimWindows().some((w) => w.container === DESK),
  JSON.stringify(shimWindows()),
);

clio(LOCAL);
await sleep(3000);
const asked = shimWindows();
check(
  'so clio opens the picker rather than putting it back',
  asked.length === 1 && asked[0].pick === true,
  JSON.stringify(asked),
);

const WINDOW_MANAGERS = ['xfwm4', 'openbox', 'marco', 'icewm', 'fluxbox', 'jwm', 'metacity'];

async function startDisplay(wm) {
  for (let n = 91; n < 130; n++) {
    if (existsSync(`/tmp/.X${n}-lock`)) continue;
    const display = `:${n}`;
    const xvfb = spawn('Xvfb', [display, '-screen', '0', '1280x900x24'], { stdio: 'ignore' });
    started.push(xvfb);
    await sleep(1500);
    if (xvfb.exitCode !== null) continue;
    started.push(spawn(wm, [], { stdio: 'ignore', env: { ...process.env, DISPLAY: display } }));
    await sleep(1500);
    return display;
  }
  return null;
}

function windowsOn(display) {
  try {
    return execFileSync('wmctrl', ['-l'], {
      encoding: 'utf8',
      env: { ...process.env, DISPLAY: display },
    })
      .trim()
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
}

const wm = WINDOW_MANAGERS.find(installed);
if (!installed('Xvfb') || !wm || !installed('wmctrl')) {
  console.log('\n6. the same thing with a real browser — skipped:');
  console.log('   needs Xvfb, a window manager and wmctrl, and this machine has not got all three');
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

execFileSync(join(ROOT, 'bin', 'clio'), ['stop'], { stdio: 'ignore', env: process.env });
await sleep(2000);
rmSync(join(process.env.XDG_STATE_HOME, 'clio', 'state.json'), { force: true });

const local = await startDisplay(wm);
const remote = local ? await startDisplay(wm) : null;
if (!local || !remote) {
  console.log('\n6. skipped: could not start two displays');
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

const real = (display, ...args) =>
  execFileSync(join(ROOT, 'bin', 'clio'), args, {
    encoding: 'utf8',
    env: { ...process.env, DISPLAY: display },
  });

console.log(`\n6. a real browser, on ${local} and then on ${remote}`);
console.log(`   ${real(local).trim()}`);
await sleep(10000);
const opened = (await status()).containers.find((c) => c.sessions.length);
check('a window came up at the machine', !!opened, JSON.stringify(await status()));
check('the window manager there can see it', windowsOn(local).length === 1, JSON.stringify(windowsOn(local)));
check('and nothing is on the other display', windowsOn(remote).length === 0, JSON.stringify(windowsOn(remote)));

const realDaemon = handshake().pid;
const realShells = shells(realDaemon);

real(remote);
await sleep(12000);
const overThere = (await status()).containers.find((c) => c.id === opened?.id);
check(
  `the window is on ${key(remote)} now`,
  overThere?.display === key(remote),
  JSON.stringify(overThere?.display),
);
check('one window there', windowsOn(remote).length === 1, JSON.stringify(windowsOn(remote)));
check('and the one at the machine has gone', windowsOn(local).length === 0, JSON.stringify(windowsOn(local)));
check(
  'the shells went through it untouched',
  JSON.stringify(shells(realDaemon)) === JSON.stringify(realShells),
  `${realShells.join(', ')} → ${shells(realDaemon).join(', ')}`,
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
