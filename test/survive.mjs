/*
 * End-to-end check of the thing that matters: a process started in a tab must
 * outlive the window that started it, and must be recoverable after the daemon
 * itself is killed outright.
 *
 * Run with the daemon already up:  node test/survive.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import WebSocket from 'ws';

const HANDSHAKE = join(process.env.XDG_RUNTIME_DIR || join(homedir(), '.cache'), 'clio', 'daemon.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function handshake() {
  return JSON.parse(readFileSync(HANDSHAKE, 'utf8'));
}

/** A stand-in for a browser window: connects, talks, and can be killed off. */
class Client {
  constructor(info) {
    this.info = info;
    this.messages = [];
    this.output = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${this.info.port}/?token=${this.info.token}`, {
        origin: `http://127.0.0.1:${this.info.port}`,
      });
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        const msg = JSON.parse(raw);
        this.messages.push(msg);
        if (msg.t === 'data') {
          this.output.set(msg.id, (this.output.get(msg.id) || '') + msg.data);
        }
        if (msg.t === 'attached') {
          this.output.set(msg.id, msg.scrollback || '');
        }
      });
    });
  }

  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }

  /** Wait for a message matching a predicate. */
  async await(pred, timeout = 4000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const hit = this.messages.find(pred);
      if (hit) return hit;
      await sleep(30);
    }
    return null;
  }

  close() {
    this.ws.close();
  }
}

/**
 * Regression: a reloaded window authenticates with the cookie alone.
 *
 * The page strips the token from its URL on load, so if the cookie exchange
 * breaks, a refresh leaves the window connected to nothing — the terminal looks
 * fine but every button silently does nothing.
 */
async function reloadSurvivesAuth(info) {
  console.log('0. a reloaded window can still authenticate');
  const origin = `http://127.0.0.1:${info.port}`;

  const first = await fetch(`${origin}/?token=${info.token}`);
  const cookie = first.headers.get('set-cookie') || '';
  check('loading the page with a token issues a cookie', cookie.includes('clio_token='));
  check('the cookie is HttpOnly', /httponly/i.test(cookie));
  check('the cookie is SameSite=Strict', /samesite=strict/i.test(cookie));

  const bare = await fetch(`${origin}/`);
  check('a tokenless page load is not given a cookie', !bare.headers.get('set-cookie'));

  const jar = cookie.split(';')[0];

  // The reload case: no token anywhere in the URL, only the cookie.
  const ws = new WebSocket(`${origin.replace('http', 'ws')}/`, {
    origin,
    headers: { cookie: jar },
  });
  const opened = await new Promise((resolve) => {
    ws.on('open', () => resolve(true));
    ws.on('error', () => resolve(false));
    setTimeout(() => resolve(false), 3000);
  });
  check('a reloaded window connects with only its cookie', opened);
  if (opened) ws.close();

  const wrong = new WebSocket(`${origin.replace('http', 'ws')}/`, {
    origin,
    headers: { cookie: 'clio_token=not-the-real-token' },
  });
  const wrongOpened = await new Promise((resolve) => {
    wrong.on('open', () => resolve(true));
    wrong.on('error', () => resolve(false));
    setTimeout(() => resolve(false), 3000);
  });
  check('a bogus cookie is still refused', !wrongOpened);

  const authed = await fetch(`${origin}/auth`, { headers: { cookie: jar } });
  const unauthed = await fetch(`${origin}/auth`);
  check('/auth confirms a good cookie', authed.status === 204, `got ${authed.status}`);
  check('/auth rejects no credentials', unauthed.status === 403, `got ${unauthed.status}`);
  console.log('');
}

async function main() {
  const info = handshake();
  console.log(`daemon on port ${info.port}, pid ${info.pid}\n`);

  await reloadSurvivesAuth(info);

  // ---- 1. a session runs and produces output -----------------------------
  console.log('1. basic session');
  const win1 = new Client(info);
  await win1.connect();
  win1.send({ t: 'create', cwd: '/tmp', cols: 80, rows: 24 });

  const created = await win1.await((m) => m.t === 'created');
  check('session created', !!created);
  const id = created?.id;
  if (!id) return report();

  await sleep(700);
  win1.send({ t: 'input', id, data: 'echo hello-from-clio\n' });
  await sleep(700);
  check('command output came back', (win1.output.get(id) || '').includes('hello-from-clio'));

  // ---- 2. a long-running process survives the window closing -------------
  console.log('\n2. window closes while a process runs');
  win1.send({ t: 'input', id, data: 'sleep 120 & echo started-$!\n' });
  await sleep(800);

  win1.send({ t: 'input', id, data: 'sleep 90\n' });
  await sleep(2500); // let the proc poller notice the foreground job

  const shellPid = created.session.pid;
  check('shell pid reported', !!shellPid);

  win1.close(); // this is the window being closed / crashing
  await sleep(1200);

  let alive = true;
  try {
    process.kill(shellPid, 0);
  } catch {
    alive = false;
  }
  check('shell still alive after the window closed', alive);

  const sleepAlive =
    execSync(`pgrep -P ${shellPid} 2>/dev/null || true`, { encoding: 'utf8' }).trim().length > 0;
  check('child process still running after the window closed', sleepAlive);

  // ---- 3. a new window reattaches to the live session --------------------
  console.log('\n3. new window reattaches');
  const win2 = new Client(info);
  await win2.connect();

  const list = await win2.await((m) => m.t === 'sessions');
  const found = list?.sessions.find((s) => s.id === id);
  check('session still listed', !!found);
  check('status is live', found?.status === 'live', `got ${found?.status}`);
  check('cwd tracked as /tmp', found?.cwd === '/tmp', `got ${found?.cwd}`);
  check(
    'running command detected',
    (found?.command || '').includes('sleep 90'),
    `got ${JSON.stringify(found?.command)}`,
  );

  win2.send({ t: 'attach', id, cols: 80, rows: 24 });
  const attached = await win2.await((m) => m.t === 'attached');
  check('reattach replayed scrollback', (attached?.scrollback || '').includes('hello-from-clio'));

  // the reattached window can still drive the shell
  win2.send({ t: 'input', id, data: '' }); // Ctrl+C to end `sleep 90`
  await sleep(600);
  win2.send({ t: 'input', id, data: 'echo second-window-works\n' });
  await sleep(800);
  check(
    'reattached window can type into the live shell',
    (win2.output.get(id) || '').includes('second-window-works'),
  );

  win2.send({ t: 'rename', id, title: 'my-tab' });
  await sleep(600);

  // Leave something running in the foreground: what the daemon does with it
  // across a crash is the part people care about.
  win2.send({ t: 'input', id, data: 'sleep 300\n' });
  await sleep(2500); // let the proc poller notice it
  win2.close();

  // ---- 4. the daemon is killed outright, then restarted ------------------
  console.log('\n4. daemon killed (SIGKILL), then restarted');
  process.kill(info.pid, 9);
  await sleep(600);

  let daemonGone = false;
  try {
    process.kill(info.pid, 0);
  } catch {
    daemonGone = true;
  }
  check('daemon is gone', daemonGone);

  execSync('./bin/clio start', { stdio: 'ignore' });
  await sleep(400);

  const info2 = handshake();
  check('daemon restarted with a new pid', info2.pid !== info.pid);
  // Stable across restarts on purpose: a window left open when the daemon died
  // reconnects to its replacement without being relaunched.
  check('kept the same port', info2.port === info.port, `${info.port} -> ${info2.port}`);
  check('kept the same token', info2.token === info.token);

  const win3 = new Client(info2);
  await win3.connect();
  const list2 = await win3.await((m) => m.t === 'sessions');
  const recovered = list2?.sessions.find((s) => s.id === id);

  check('tab came back after the crash', !!recovered);
  // A tab with no pty behind it is a tab that cannot be typed in, so the daemon
  // opens the shell rather than leaving it to be asked for.
  check('came back with a shell already running', recovered?.status === 'live',
    `got ${recovered?.status}`);
  check('remembers its title', recovered?.title === 'my-tab', `got ${recovered?.title}`);
  check('remembers its directory', recovered?.cwd === '/tmp', `got ${recovered?.cwd}`);

  win3.send({ t: 'attach', id, cols: 80, rows: 24 });
  const attached2 = await win3.await((m) => m.t === 'attached');
  const replayed = attached2?.scrollback || '';
  check('saved scrollback survived the crash', replayed.includes('hello-from-clio'));
  // The old prompt is still up there and must not read as though it were live.
  check('the seam marks where the new shell starts', replayed.includes('new shell'),
    JSON.stringify(replayed.slice(-160)));
  check(
    'and says the interrupted command was not restarted',
    replayed.includes('sleep 300') && replayed.includes('was not restarted'),
    JSON.stringify(replayed.slice(-160)),
  );

  // ---- 5. the recovered tab is usable straight away -----------------------
  console.log('\n5. the recovered tab is usable straight away');
  await sleep(700);
  win3.output.set(id, '');
  win3.send({ t: 'input', id, data: 'pwd\n' });
  await sleep(800);
  check(
    'the new shell opened in the saved directory',
    (win3.output.get(id) || '').includes('/tmp'),
    JSON.stringify((win3.output.get(id) || '').slice(-80)),
  );

  win3.output.set(id, '');
  win3.send({ t: 'input', id, data: 'echo typed-without-being-asked\n' });
  await sleep(800);
  check(
    'and takes typing with nothing to click first',
    (win3.output.get(id) || '').includes('typed-without-being-asked'),
  );

  // ---- cleanup ------------------------------------------------------------
  win3.send({ t: 'close', id });
  await sleep(400);
  const list3 = await win3.await((m) => m.t === 'sessions' && !m.sessions.some((s) => s.id === id));
  check('closing a tab removes it', !!list3);
  win3.close();

  report();
}

function report() {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('test harness error:', err);
  process.exit(1);
});
