import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
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

class Client {
  constructor(info, container = null) {
    this.info = info;
    this.container = container;
    this.sessions = [];
    this.messages = [];
    this.output = new Map();
  }

  connect() {
    const query = `?token=${this.info.token}${this.container ? `&c=${this.container}` : ''}`;
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${this.info.port}/${query}`, {
        origin: `http://127.0.0.1:${this.info.port}`,
      });
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        const msg = JSON.parse(raw);
        this.messages.push(msg);
        if (msg.t === 'sessions') {
          this.container = msg.container;
          this.sessions = msg.sessions;
        }
        if (msg.t === 'data') {
          this.output.set(msg.id, (this.output.get(msg.id) || '') + msg.data);
        }
        if (msg.t === 'attached') {
          this.output.set(msg.id, msg.scrollback || '');
        }
      });
    });
  }

  has(id) {
    return this.sessions.some((s) => s.id === id);
  }

  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }

  async await(pred, timeout = 4000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const hit = this.messages.find(pred);
      if (hit) return hit;
      await sleep(30);
    }
    return null;
  }

  close({ goodbye = true } = {}) {
    if (goodbye && this.container) {
      fetch(
        `http://127.0.0.1:${this.info.port}/gone?c=${this.container}&token=${this.info.token}`,
        { method: 'POST' },
      ).catch(() => {
      });
    }
    this.ws.close();
  }
}

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

async function onlyAgainstASandbox(info) {
  const status = await fetch(`http://127.0.0.1:${info.port}/status?token=${info.token}`)
    .then((res) => res.json())
    .catch(() => null);
  if (status?.dev) return;

  console.error('This test kills the daemon and the shells in it, so it only runs');
  console.error('against a sandbox. Start one, and point this at it:');
  console.error('');
  console.error('  export CLIO_SANDBOX="$(mktemp -d)"');
  console.error('  export XDG_RUNTIME_DIR="$CLIO_SANDBOX/run" XDG_STATE_HOME="$CLIO_SANDBOX/state" CLIO_DEV=1');
  console.error('  bin/clio start && node test/survive.mjs');
  console.error('');
  console.error('Set CLIO_TEST_LIVE=1 to override, if the daemon really is disposable.');
  if (process.env.CLIO_TEST_LIVE !== '1') process.exit(2);
}

async function main() {
  const info = handshake();
  await onlyAgainstASandbox(info);
  console.log(`daemon on port ${info.port}, pid ${info.pid}\n`);

  await reloadSurvivesAuth(info);

  const windowA = randomBytes(4).toString('hex');
  const windowB = randomBytes(4).toString('hex');

  console.log('1. basic session');
  const win1 = new Client(info, windowA);
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

  console.log('\n2. the connection drops while a process runs');
  win1.send({ t: 'input', id, data: 'sleep 120 & echo started-$!\n' });
  await sleep(800);

  win1.send({ t: 'input', id, data: 'sleep 90\n' });
  await sleep(2500);

  const shellPid = created.session.pid;
  check('shell pid reported', !!shellPid);

  win1.close();
  await sleep(1200);

  let alive = true;
  try {
    process.kill(shellPid, 0);
  } catch {
    alive = false;
  }
  check('shell still alive with the connection only just gone', alive);

  const sleepAlive =
    execSync(`pgrep -P ${shellPid} 2>/dev/null || true`, { encoding: 'utf8' }).trim().length > 0;
  check('child process still running too', sleepAlive);

  console.log('\n3. the window comes back');
  const win2 = new Client(info, windowA);
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

  win2.send({ t: 'input', id, data: '' });
  await sleep(600);
  win2.send({ t: 'input', id, data: 'echo second-window-works\n' });
  await sleep(800);
  check(
    'reattached window can type into the live shell',
    (win2.output.get(id) || '').includes('second-window-works'),
  );

  win2.send({ t: 'rename', id, title: 'my-tab' });
  await sleep(600);

  console.log('\n3b. a second window has its own tabs');
  const other = new Client(info, windowB);
  await other.connect();
  await other.await((m) => m.t === 'sessions');
  other.send({ t: 'create', cwd: '/etc', cols: 80, rows: 24 });
  const otherTab = await other.await((m) => m.t === 'created');
  check('the second window opened its own tab', !!otherTab);
  await sleep(600);

  check('it is a different window', other.container !== win2.container,
    `${other.container} vs ${win2.container}`);
  check("it does not show the first window's tabs", !other.has(id));
  check("and the first window does not show its tab", !win2.has(otherTab.id));

  other.send({ t: 'attach', id, cols: 80, rows: 24 });
  check('it cannot attach to a tab from the other window',
    !!(await other.await((m) => m.t === 'gone' && m.id === id, 2000)));

  other.send({ t: 'input', id: otherTab.id, data: 'echo second-window-mark\n' });
  await sleep(4000);
  other.close();

  win2.send({ t: 'input', id, data: 'printf "\\033[?1049h\\033[?1003h\\033[?1006h"\n' });
  await sleep(600);

  win2.send({ t: 'input', id, data: 'sleep 300\n' });
  await sleep(4000);
  win2.close();

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
  check('kept the same port', info2.port === info.port, `${info.port} -> ${info2.port}`);
  check('kept the same token', info2.token === info.token);

  const win3 = new Client(info2, windowA);
  await win3.connect();
  const list2 = await win3.await((m) => m.t === 'sessions');
  const recovered = list2?.sessions.find((s) => s.id === id);

  check('tab came back after the crash', !!recovered);
  check('came back with a shell already running', recovered?.status === 'live',
    `got ${recovered?.status}`);
  check('remembers its title', recovered?.title === 'my-tab', `got ${recovered?.title}`);
  check('remembers its directory', recovered?.cwd === '/tmp', `got ${recovered?.cwd}`);

  win3.send({ t: 'attach', id, cols: 80, rows: 24 });
  const attached2 = await win3.await((m) => m.t === 'attached');
  const replayed = attached2?.scrollback || '';
  check('saved scrollback survived the crash', replayed.includes('hello-from-clio'));
  check('the seam marks where the new shell starts', replayed.includes('new shell'),
    JSON.stringify(replayed.slice(-160)));
  check(
    'and says the interrupted command was not restarted',
    replayed.includes('sleep 300') && replayed.includes('was not restarted'),
    JSON.stringify(replayed.slice(-160)),
  );

  const seamAt = replayed.indexOf('new shell');
  const modeOff = (on, off) => {
    const last = replayed.lastIndexOf(on);
    const cleared = last === -1 ? -1 : replayed.indexOf(off, last);
    return last !== -1 && cleared !== -1 && cleared < seamAt;
  };
  check('mouse reporting is turned off before the new shell', modeOff('\x1b[?1003h', '\x1b[?1003l'));
  check('so is its SGR encoding', modeOff('\x1b[?1006h', '\x1b[?1006l'));
  check('and the alternate screen is left', modeOff('\x1b[?1049h', '\x1b[?1049l'));

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

  console.log('\n4b. the second window came back too');
  const other2 = new Client(info2, windowB);
  await other2.connect();
  const otherList = await other2.await((m) => m.t === 'sessions');
  check('it is still the same window', other2.container === windowB, other2.container);
  check('with its own tab in it', other2.has(otherTab.id), JSON.stringify(otherList?.sessions));
  check("and none of the other window's", !other2.has(id));

  other2.send({ t: 'attach', id: otherTab.id, cols: 80, rows: 24 });
  const otherAttached = await other2.await((m) => m.t === 'attached');
  check(
    'its scrollback came back with it',
    (otherAttached?.scrollback || '').includes('second-window-mark'),
    JSON.stringify((otherAttached?.scrollback || '').slice(-120)),
  );

  const live = await (
    await fetch(`http://127.0.0.1:${info2.port}/status?token=${info2.token}`)
  ).json();
  const known = live.containers.filter((c) => c.id === windowA || c.id === windowB);
  check('the daemon knows about both windows', known.length === 2,
    JSON.stringify(live.containers.map((c) => c.id)));
  check('and has a window open on each', known.every((c) => c.onScreen));

  console.log('\n6. a closed window keeps its shells, under a name');
  const windowC = randomBytes(4).toString('hex');
  const win4 = new Client(info2, windowC);
  await win4.connect();
  await win4.await((m) => m.t === 'sessions');
  win4.send({ t: 'create', cwd: '/tmp', cols: 80, rows: 24 });

  const kept = await win4.await((m) => m.t === 'created');
  check('a window to close, with a shell in it', !!kept);
  if (!kept) return report();

  const keptPid = kept.session.pid;
  await sleep(700);
  win4.send({ t: 'input', id: kept.id, data: 'sleep 601 &\n' });
  await sleep(800);
  const jobs = () =>
    execSync('pgrep -f "sleep 6[0]1" 2>/dev/null || true', { encoding: 'utf8' }).trim();
  check('its background job is running', jobs().length > 0);

  win4.send({ t: 'renamewindow', name: 'the one with the job in it' });
  await sleep(400);

  win4.close();
  await sleep(13000);

  let stillThere = true;
  try {
    process.kill(keptPid, 0);
  } catch {
    stillThere = false;
  }
  check('the shell in the closed window is still running', stillThere);
  check('and so is the job it was running', jobs().length > 0);

  const afterClose = await (
    await fetch(`http://127.0.0.1:${info2.port}/status?token=${info2.token}`)
  ).json();
  const put = afterClose.containers.find((c) => c.id === windowC);
  check('the window is still known to the daemon', !!put);
  check('it is marked as closed and kept', !!put?.saved);
  check('under the name it was given', put?.name === 'the one with the job in it', put?.name);

  const win5 = new Client(info2, windowC);
  await win5.connect();
  const backAgain = await win5.await((m) => m.t === 'sessions' && m.sessions.length > 0);
  check('opening it again brings the tabs back', !!backAgain);
  check(
    'with the very same shell behind them',
    backAgain?.sessions[0]?.pid === keptPid,
    `${backAgain?.sessions[0]?.pid} vs ${keptPid}`,
  );

  const reopened = await (
    await fetch(`http://127.0.0.1:${info2.port}/status?token=${info2.token}`)
  ).json();
  check(
    'and it counts as on screen again, not as one still waiting',
    reopened.containers.find((c) => c.id === windowC)?.saved === false,
  );

  console.log('\n6b. a kept window can be discarded on purpose');
  win5.close();
  await sleep(12000);

  const win6 = new Client(info2, randomBytes(4).toString('hex'));
  await win6.connect();
  await win6.await((m) => m.t === 'sessions');
  win6.send({ t: 'discard', container: windowC });
  await sleep(1500);

  let discarded = true;
  try {
    process.kill(keptPid, 0);
  } catch {
    discarded = false;
  }
  check('discarding it ends the shell', !discarded);
  check('and the job with it', jobs().length === 0, jobs());

  const afterDiscard = await (
    await fetch(`http://127.0.0.1:${info2.port}/status?token=${info2.token}`)
  ).json();
  check(
    'and the window is forgotten',
    !afterDiscard.containers.some((c) => c.id === windowC),
    JSON.stringify(afterDiscard.containers.map((c) => c.id)),
  );
  win6.close();

  win3.send({ t: 'close', id });
  await sleep(400);
  const list3 = await win3.await((m) => m.t === 'sessions' && !m.sessions.some((s) => s.id === id));
  check('closing a tab removes it', !!list3);

  for (const tab of other2.sessions) other2.send({ t: 'close', id: tab.id });
  await sleep(600);
  const cleaned = await (
    await fetch(`http://127.0.0.1:${info2.port}/status?token=${info2.token}`)
  ).json();
  check(
    'a window whose last tab closed is forgotten',
    !cleaned.containers.some((c) => c.id === windowA || c.id === windowB),
    JSON.stringify(cleaned.containers.map((c) => c.id)),
  );

  win3.close();
  other2.close();

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
