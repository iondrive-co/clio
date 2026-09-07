import { mkdtempSync, rmSync, readFileSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
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

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function childrenOf(pid) {
  return execSync(`pgrep -P ${pid} 2>/dev/null || true`, { encoding: 'utf8' }).trim();
}

const tree = mkdtempSync(join(tmpdir(), 'clio-reload-'));
const clio = join(tree, 'bin', 'clio');
const env = {
  ...process.env,
  XDG_RUNTIME_DIR: join(tree, 'run'),
  XDG_STATE_HOME: join(tree, 'state'),
  CLIO_DEV: '1',
  CLAUDECODE: '1',
  CLAUDE_CODE_SESSION_ID: 'a-session-that-is-not-this-shell',
  CLAUDE_CODE_CHILD_SESSION: '1',
  TRACEPARENT: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
};
const HANDSHAKE = join(tree, 'run', 'clio', 'daemon.json');

const extraTrees = [];

function setUp() {
  for (const item of ['src', 'bin', 'assets', 'package.json']) {
    execFileSync('cp', ['-aL', join(REPO, item), tree]);
  }
  symlinkSync(join(REPO, 'node_modules'), join(tree, 'node_modules'));
}

function tearDown() {
  try {
    execFileSync(clio, ['stop'], { env, stdio: 'ignore' });
  } catch {
  }
  if (process.env.CLIO_KEEP_TREE === '1') {
    console.log(`\nsandbox left behind for inspection: ${[tree, ...extraTrees].join(', ')}`);
    return;
  }
  for (const path of [tree, ...extraTrees]) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
    }
  }
}

process.on('exit', tearDown);

function handshake() {
  return JSON.parse(readFileSync(HANDSHAKE, 'utf8'));
}

async function daemonAfter(oldPid, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const info = handshake();
      if (info.pid !== oldPid && alive(info.pid)) return info;
    } catch {
    }
    await sleep(100);
  }
  return null;
}

class Client {
  constructor(info, container) {
    this.info = info;
    this.container = container;
    this.sessions = [];
    this.messages = [];
    this.output = new Map();
  }

  connect() {
    const origin = `http://127.0.0.1:${this.info.port}`;
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(
        `ws://127.0.0.1:${this.info.port}/?token=${this.info.token}&c=${this.container}`,
        { origin },
      );
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        const msg = JSON.parse(raw);
        this.messages.push(msg);
        if (msg.t === 'sessions') this.sessions = msg.sessions;
        if (msg.t === 'data') this.output.set(msg.id, (this.output.get(msg.id) || '') + msg.data);
        if (msg.t === 'attached') this.output.set(msg.id, msg.scrollback || '');
      });
    });
  }

  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }

  async await(pred, timeout = 5000) {
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

async function main() {
  setUp();
  execFileSync(clio, ['start'], { env, stdio: 'ignore' });
  await sleep(500);

  const first = handshake();
  console.log(`sandbox daemon on port ${first.port}, pid ${first.pid}\n`);

  console.log('1. a tab with work in it');
  const windowId = randomBytes(4).toString('hex');
  const win = new Client(first, windowId);
  await win.connect();
  win.send({ t: 'create', cwd: '/tmp', cols: 80, rows: 24 });

  const created = await win.await((m) => m.t === 'created');
  check('session created', !!created);
  if (!created) return;

  const id = created.id;
  const shellPid = created.session.pid;
  await sleep(600);

  win.send({ t: 'input', id, data: 'echo before-the-reload\n' });
  await sleep(600);
  check('the shell answers', (win.output.get(id) || '').includes('before-the-reload'));

  win.send({ t: 'input', id, data: 'sleep 987654 &\n' });
  await sleep(800);
  const backgrounded = childrenOf(shellPid);
  check('it has a process running under it', backgrounded.length > 0);

  win.send({
    t: 'input',
    id,
    data: 'echo "markers:[${CLAUDECODE:-}][${CLAUDE_CODE_SESSION_ID:-}][${TRACEPARENT:-}]"\n',
  });
  await sleep(800);
  const seen = win.output.get(id) || '';
  check(
    'the shell did not inherit the agent session that started the daemon',
    seen.includes('markers:[][][]'),
    seen.slice(-160),
  );

  win.send({ t: 'rename', id, title: 'work-in-progress' });

  win.send({ t: 'create', cwd: '/tmp', cols: 80, rows: 24 });
  const quietTab = await win.await((m) => m.t === 'created' && m.id !== id);
  check('a second tab to be quiet in', !!quietTab);
  const quiet = quietTab?.id;
  await sleep(600);

  win.send({
    t: 'input',
    id: quiet,
    data:
      'printf "\\033]0;a-job-with-a-name\\007"; ' +
      'head -c 700000 /dev/zero | tr "\\0" x; echo; sleep 987654\n',
  });
  const named = await win.await(
    (m) =>
      m.t === 'sessions' &&
      m.sessions.find((s) => s.id === quiet)?.termTitle === 'a-job-with-a-name',
    10000,
  );
  check('the tab is named after what it says it is doing', !!named);

  await sleep(3500);

  console.log('\n2. clio reload');
  const out = execFileSync(clio, ['reload'], { env, encoding: 'utf8' });
  check('the launcher reports a reload', /reloaded/.test(out), out.trim());

  const second = await daemonAfter(first.pid);
  check('a new daemon is running', !!second && second.pid !== first.pid);
  if (!second) return;

  for (let i = 0; i < 50 && alive(first.pid); i++) await sleep(100);
  check('the old daemon stood down', !alive(first.pid));
  check('same port', second.port === first.port, `${first.port} -> ${second.port}`);
  check('same token', second.token === first.token);

  console.log('\n3. the shell never knew');
  check('the shell is the same process', alive(shellPid), `pid ${shellPid}`);
  check('its child is still running', childrenOf(shellPid) === backgrounded,
    `${backgrounded} -> ${childrenOf(shellPid)}`);

  const win2 = new Client(second, windowId);
  await win2.connect();
  const listed = await win2.await((m) => m.t === 'sessions');
  const tab = listed?.sessions.find((s) => s.id === id);

  check('the tab is still there', !!tab);
  check('with the same shell behind it', tab?.pid === shellPid, `${shellPid} -> ${tab?.pid}`);
  check('still named what it was named', tab?.title === 'work-in-progress');

  const quietAfter = listed?.sessions.find((s) => s.id === quiet);
  check(
    'and a quiet tab still called what it called itself',
    quietAfter?.termTitle === 'a-job-with-a-name',
    JSON.stringify(quietAfter?.termTitle),
  );
  check('still in the directory it was in', tab?.cwd === '/tmp', tab?.cwd);

  win2.send({ t: 'attach', id, cols: 80, rows: 24 });
  const attached = await win2.await((m) => m.t === 'attached');
  const replayed = attached?.scrollback || '';
  check('the scrollback carried across', replayed.includes('before-the-reload'));
  check('and nothing was restarted', !replayed.includes('new shell'),
    JSON.stringify(replayed.slice(-120)));

  await sleep(400);
  win2.output.set(id, '');
  win2.send({ t: 'input', id, data: 'echo after-the-reload\n' });
  await sleep(900);
  check('typing still reaches the shell', (win2.output.get(id) || '').includes('after-the-reload'));

  win2.send({ t: 'resize', id, cols: 100, rows: 30 });
  await sleep(300);
  win2.output.set(id, '');
  win2.send({ t: 'input', id, data: 'stty size\n' });
  await sleep(900);
  check('and the pty still takes a resize', (win2.output.get(id) || '').includes('30 100'),
    JSON.stringify((win2.output.get(id) || '').slice(-60)));

  console.log('\n4. a reload into code that does not start');
  const victim = join(tree, 'src', 'daemon', 'window.js');
  const original = readFileSync(victim, 'utf8');
  writeFileSync(victim, `${original}\nthis is not javascript(\n`);

  let refused = false;
  try {
    execFileSync(clio, ['reload'], { env, encoding: 'utf8', stdio: 'pipe' });
  } catch {
    refused = true;
  }
  check('the launcher says the reload failed', refused);
  check('the daemon that had the shells is still running', alive(second.pid));
  check('the shell is still alive', alive(shellPid));
  check('and still has its child', childrenOf(shellPid) === backgrounded);

  writeFileSync(victim, original);

  const win3 = new Client(handshake(), windowId);
  await win3.connect();
  await win3.await((m) => m.t === 'sessions');
  win3.send({ t: 'attach', id, cols: 80, rows: 24 });
  await win3.await((m) => m.t === 'attached');
  win3.output.set(id, '');
  win3.send({ t: 'input', id, data: 'echo still-here\n' });
  await sleep(900);
  check('and the tab still works after the failed reload',
    (win3.output.get(id) || '').includes('still-here'));

  console.log('\n5. reloading again, now the code is fixed');
  const before = handshake().pid;
  execFileSync(clio, ['reload'], { env, encoding: 'utf8' });
  const third = await daemonAfter(before);
  check('it reloaded', !!third);
  check('with the shell still running', alive(shellPid));
  if (!third) return;

  console.log('\n6. the windows are told when the UI changes');
  const win4 = new Client(third, windowId);
  await win4.connect();
  await win4.await((m) => m.t === 'sessions');

  const css = join(tree, 'src', 'ui', 'style.css');
  writeFileSync(css, `${readFileSync(css, 'utf8')}\n/* touched by the test */\n`);

  check('the window is told to reload', !!(await win4.await((m) => m.t === 'reload', 4000)));
  check('and the shell is untouched by that', alive(shellPid));

  console.log('\n7. a reload takes the display it was run from');
  const beforeDisplay = handshake().pid;
  execFileSync(clio, ['reload'], { env: { ...env, DISPLAY: ':77' }, encoding: 'utf8' });
  const fourth = await daemonAfter(beforeDisplay);
  check('it reloaded', !!fourth);
  if (!fourth) return;

  const win5 = new Client(fourth, windowId);
  await win5.connect();
  await win5.await((m) => m.t === 'sessions');
  win5.send({ t: 'create', cwd: '/tmp', cols: 80, rows: 24 });
  const fresh = await win5.await((m) => m.t === 'created');
  check('a new tab opened', !!fresh);

  const shellEnv = readFileSync(`/proc/${fresh?.session.pid}/environ`, 'utf8').split('\0');
  check('and its shell has the display the launcher had', shellEnv.includes('DISPLAY=:77'));
  check('with the terminal settings still right', shellEnv.includes('TERM=xterm-256color'));
  check('the shell that was already open is untouched', alive(shellPid));

  console.log('\n8. reloading into a different copy of clio');
  const elsewhere = mkdtempSync(join(tmpdir(), 'clio-elsewhere-'));
  extraTrees.push(elsewhere);
  for (const item of ['src', 'bin', 'assets', 'package.json']) {
    execFileSync('cp', ['-a', join(tree, item), elsewhere]);
  }
  symlinkSync(join(REPO, 'node_modules'), join(elsewhere, 'node_modules'));

  const beforeMove = handshake().pid;
  execFileSync(join(elsewhere, 'bin', 'clio'), ['reload'], { env, encoding: 'utf8' });
  const moved = await daemonAfter(beforeMove);
  check('it reloaded', !!moved);
  if (!moved) return;

  const cmdline = readFileSync(`/proc/${moved.pid}/cmdline`, 'utf8');
  check('the daemon is running the other copy now', cmdline.includes(elsewhere), cmdline);
  check('and the shell came across with it', alive(shellPid));
  check('still with its child', childrenOf(shellPid) === backgrounded);
}

main()
  .catch((err) => {
    failed++;
    console.error('\nthe test itself failed:', err);
  })
  .finally(async () => {
    console.log(`\n${passed} passed, ${failed} failed`);
    if (existsSync(HANDSHAKE)) {
      try {
        execFileSync(clio, ['stop'], { env, stdio: 'ignore' });
      } catch {
      }
    }
    process.exit(failed ? 1 : 0);
  });
