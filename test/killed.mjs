/*
 * A window whose page was killed is not a window somebody closed.
 *
 * The two are the same event from the daemon's side — the socket drops and
 * nothing comes back — and they need opposite answers. A closed window is put
 * away under its name and nothing more is said about it. A killed one is still
 * on screen, with Chrome's own error page where the terminal was: "Aw, Snap!"
 * the first time, "Can't open this page" the second, neither of them ours to
 * write in, and Ctrl+R the only thing that helps. So it is said everywhere it
 * can be said instead — the desktop, `clio status`, and the window itself once
 * it comes back.
 *
 * What earlyoom does on this machine is SIGTERM the renderer, so that is what
 * this does. Runs a clio of its own, on its own state, on its own display:
 *
 *   node test/killed.mjs
 */
import { mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync, chmodSync } from 'node:fs';
import { execFileSync, execSync, spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Nothing this test opens or kills may land on the desktop of whoever is
// running it, and nothing it says may land on their notification tray either.
delete process.env.DISPLAY;
delete process.env.WAYLAND_DISPLAY;

const SANDBOX = mkdtempSync(join(tmpdir(), 'clio-killed-'));
process.env.XDG_RUNTIME_DIR = join(SANDBOX, 'run');
process.env.XDG_STATE_HOME = join(SANDBOX, 'state');
process.env.CLIO_DEV = '1';
// The UI watcher would reload the windows out from under this test.
process.env.CLIO_NO_UI_WATCH = '1';
mkdirSync(process.env.XDG_RUNTIME_DIR, { recursive: true });
mkdirSync(process.env.XDG_STATE_HOME, { recursive: true });

// Where the desktop notification goes instead of the desktop.
const NOTICES = join(SANDBOX, 'notices.log');
const NOTIFIER = join(SANDBOX, 'notifier');
writeFileSync(NOTIFIER, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${NOTICES}\n`);
chmodSync(NOTIFIER, 0o755);
process.env.CLIO_NOTIFIER = NOTIFIER;

const HANDSHAKE = join(process.env.XDG_RUNTIME_DIR, 'clio', 'daemon.json');
const PROFILE = join(process.env.XDG_STATE_HOME, 'clio', 'browser-profile');

// The grace period a window gets to come back in, plus the moment the daemon
// waits before it says anything, plus room to be slow.
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
    /* never started, or already down */
  }
  // Only this run's browser: every one of these was launched with this
  // sandbox's profile, and nothing else on the machine has that path in it.
  for (const pid of browserProcs()) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  while (started.length) {
    try {
      started.pop().kill('SIGKILL');
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

/**
 * This sandbox's browser processes, by the profile path in their command line.
 *
 * Never by name: every process in every Chrome on the machine is called
 * `chrome`, this test's and the user's alike. Chrome also rewrites its argv
 * into one string, so /proc/pid/cmdline is not NUL-separated for its children
 * and the raw text is what there is to match on.
 */
function browserProcs(type = null) {
  const out = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    let cmd;
    try {
      cmd = readFileSync(`/proc/${entry}/cmdline`, 'utf8');
    } catch {
      continue; // it exited while we were looking at it
    }
    if (!cmd.includes(PROFILE) || !/chrome|chromium|brave/.test(cmd)) continue;
    const kind = (cmd.match(/--type=(\S+)/) || [null, 'browser'])[1];
    if (type && kind !== type) continue;
    // Chrome's own UI runs in a renderer too, and it is not the page.
    if (type === 'renderer' && cmd.includes('--top-chrome-webui')) continue;
    out.push(Number(entry));
  }
  return out;
}

/** A display of this test's own, or null if the machine cannot provide one. */
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
const notices = () => (existsSync(NOTICES) ? readFileSync(NOTICES, 'utf8').trim().split('\n').filter(Boolean) : []);

async function status() {
  const { port, token } = handshake();
  const res = await fetch(`http://127.0.0.1:${port}/status?token=${token}`);
  return res.json();
}

/** What the daemon says to a window, without opening one. */
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

/* ------------------------------------------------------- 1. a page that died */

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

/* ------------------------------- 2. what a window showing those tabs is told */

console.log('\n2. the window that comes back is told what happened to the last one');

const returning = await connect(first.id);
await sleep(1500);
check('it hears that its predecessor was killed', returning.said('killed'));
check(
  'and the flag is spent — a reload after that is not told twice',
  (await status()).containers.find((c) => c.id === first.id)?.killed === false,
);
returning.ws.close();
// That socket went the way a killed page's does, with no goodbye, so the daemon
// is about to call it one. Let it, rather than leave it landing mid-phase.
await sleep(AFTER_GRACE_MS);
const spent = notices().length;

/* --------------------------------------------- 3. and Ctrl+R is all it takes */

console.log('\n3. Ctrl+R in the window brings it back');
pressCtrlR();
await sleep(7000);
const revived = (await status()).containers.find((c) => c.id === first.id);
check('the window is showing its tabs again', revived?.onScreen === true, JSON.stringify(revived));
check('with the same shells in them', revived?.sessions.length === afterKill?.sessions.length);
check('and it is not flagged as killed any more', revived?.killed === false);

/* ----------------------------------- 4. a reload is not a window being killed */

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

/* ------------------------- 5. nor is the daemon being replaced underneath it */

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

/* ---------------------------------- 6. and neither is a window being closed */

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
