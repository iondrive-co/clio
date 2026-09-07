import { mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync, chmodSync } from 'node:fs';
import { execFileSync, execSync, spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

delete process.env.DISPLAY;
delete process.env.WAYLAND_DISPLAY;

const SANDBOX = mkdtempSync(join(tmpdir(), 'clio-killed-'));
process.env.XDG_RUNTIME_DIR = join(SANDBOX, 'run');
process.env.XDG_STATE_HOME = join(SANDBOX, 'state');
process.env.CLIO_DEV = '1';
process.env.CLIO_NO_UI_WATCH = '1';
mkdirSync(process.env.XDG_RUNTIME_DIR, { recursive: true });
mkdirSync(process.env.XDG_STATE_HOME, { recursive: true });

const NOTICES = join(SANDBOX, 'notices.log');
const NOTIFIER = join(SANDBOX, 'notifier');
writeFileSync(NOTIFIER, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${NOTICES}\n`);
chmodSync(NOTIFIER, 0o755);
process.env.CLIO_NOTIFIER = NOTIFIER;

const HANDSHAKE = join(process.env.XDG_RUNTIME_DIR, 'clio', 'daemon.json');
const PROFILE = join(process.env.XDG_STATE_HOME, 'clio', 'browser-profile');

const AFTER_GRACE_MS = 14000;

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
    execFileSync(join(ROOT, 'bin', 'clio'), ['stop'], { stdio: 'ignore', env: process.env });
  } catch {
  }
  for (const pid of browserProcs()) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
    }
  }
  while (started.length) {
    try {
      started.pop().kill('SIGKILL');
    } catch {
    }
  }
  try {
    rmSync(SANDBOX, { recursive: true, force: true });
  } catch {
  }
});

function browserProcs(type = null) {
  const out = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    let cmd;
    try {
      cmd = readFileSync(`/proc/${entry}/cmdline`, 'utf8');
    } catch {
      continue;
    }
    if (!cmd.includes(PROFILE) || !/chrome|chromium|brave/.test(cmd)) continue;
    const kind = (cmd.match(/--type=(\S+)/) || [null, 'browser'])[1];
    if (type && kind !== type) continue;
    if (type === 'renderer' && cmd.includes('--top-chrome-webui')) continue;
    out.push(Number(entry));
  }
  return out;
}

async function startDisplay() {
  if (!installed('Xvfb')) return null;
  const wm = WINDOW_MANAGERS.find(installed);
  if (!wm) return null;

  for (let n = 95; n < 130; n++) {
    if (existsSync(`/tmp/.X${n}-lock`)) continue;
    const display = `:${n}`;
    const xvfb = spawn('Xvfb', [display, '-screen', '0', '1400x900x24'], { stdio: 'ignore' });
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
const notices = () => (existsSync(NOTICES) ? readFileSync(NOTICES, 'utf8').trim().split('\n').filter(Boolean) : []);

async function status() {
  const { port, token } = handshake();
  const res = await fetch(`http://127.0.0.1:${port}/status?token=${token}`);
  return res.json();
}

async function connect(container) {
  const { port, token } = handshake();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}&c=${container}`, {
    origin: `http://127.0.0.1:${port}`,
  });
  const heard = [];
  ws.on('message', (raw) => heard.push(JSON.parse(raw)));
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  return { ws, heard, said: (t) => heard.some((m) => m.t === t) };
}

const x = (cmd, ...args) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', env: process.env }).trim();
  } catch {
    return '';
  }
};

console.log(`clio killed-window test — sandbox at ${SANDBOX}`);

const display = await startDisplay();
if (!display) {
  console.log('no Xvfb and window manager on this machine — nothing to test');
  process.exit(0);
}
if (!installed('xdotool') || !installed('wmctrl')) {
  console.log('xdotool and wmctrl are needed to press keys at a window — skipping');
  process.exit(0);
}
process.env.DISPLAY = display;
console.log(`display ${display}`);

console.log(clio().trim());
await sleep(9000);

const win = () => x('xdotool', 'search', '--class', 'clio').split('\n').filter(Boolean).pop();
const pressCtrlR = () => {
  x('xdotool', 'windowactivate', '--sync', win());
  x('xdotool', 'key', '--clearmodifiers', 'ctrl+r');
};

const first = (await status()).containers[0];
check('a window is on screen', !!first?.onScreen, JSON.stringify(first));

console.log('\n1. the renderer is killed, the way earlyoom kills it');

const renderers = browserProcs('renderer');
check('the page has a renderer of its own to lose', renderers.length > 0);
for (const pid of renderers) process.kill(pid, 'SIGTERM');
await sleep(AFTER_GRACE_MS);

const afterKill = (await status()).containers.find((c) => c.id === first.id);
check('the daemon knows the page was killed', afterKill?.killed === true, JSON.stringify(afterKill));
check('and its shells were kept, not ended', afterKill?.sessions.length > 0);
check(
  'the desktop was told once, by name, with the key that fixes it',
  notices().length === 1 &&
    /Ctrl\+R/.test(notices()[0]) &&
    /killed/.test(notices()[0]) &&
    (afterKill?.name ? notices()[0].includes(afterKill.name) : true),
  JSON.stringify(notices()),
);
check(
  '`clio status` says what to do about it',
  /its page was killed; press Ctrl\+R/.test(clio('status')),
  clio('status'),
);

console.log('\n2. the window that comes back is told what happened to the last one');

const returning = await connect(first.id);
await sleep(1500);
check('it hears that its predecessor was killed', returning.said('killed'));
check(
  'and the flag is spent — a reload after that is not told twice',
  (await status()).containers.find((c) => c.id === first.id)?.killed === false,
);
returning.ws.close();
await sleep(AFTER_GRACE_MS);
const spent = notices().length;

console.log('\n3. Ctrl+R in the window brings it back');
pressCtrlR();
await sleep(7000);
const revived = (await status()).containers.find((c) => c.id === first.id);
check('the window is showing its tabs again', revived?.onScreen === true, JSON.stringify(revived));
check('with the same shells in them', revived?.sessions.length === afterKill?.sessions.length);
check('and it is not flagged as killed any more', revived?.killed === false);

console.log('\n4. a reload says nothing to anybody');
pressCtrlR();
await sleep(AFTER_GRACE_MS);
check(
  'nothing was said about a window that only reloaded',
  notices().length === spent,
  JSON.stringify(notices().slice(spent)),
);
check(
  'and it is still on screen',
  (await status()).containers.find((c) => c.id === first.id)?.onScreen === true,
);

console.log('\n5. a reload of the daemon says nothing either');
clio('reload');
await sleep(AFTER_GRACE_MS);
check(
  'a window whose daemon was replaced was not called killed',
  notices().length === spent,
  JSON.stringify(notices().slice(spent)),
);
check(
  'and it came back on the new daemon by itself',
  (await status()).containers.find((c) => c.id === first.id)?.onScreen === true,
);

console.log('\n6. a window somebody closes goes quietly');
const id = win();
x('wmctrl', '-i', '-c', `0x${Number(id).toString(16).padStart(8, '0')}`);
await sleep(AFTER_GRACE_MS);

const closed = (await status()).containers.find((c) => c.id === first.id);
check('the window was put away under its name', closed?.saved === true, JSON.stringify(closed));
check('it is not called killed', closed?.killed === false);
check(
  'and the desktop heard nothing about it',
  notices().length === spent,
  JSON.stringify(notices().slice(spent)),
);

const reopened = await connect(first.id);
await sleep(1500);
check('a window opening it again is told nothing either', !reopened.said('killed'));
reopened.ws.close();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
