import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  existsSync,
  rmSync,
  copyFileSync,
  chmodSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';

import { scriptIn } from '../src/scripts/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const log = [];

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

const TMP = mkdtempSync(join(tmpdir(), 'clio-scripts-'));
const RUN = join(TMP, 'run');
const STATE = join(TMP, 'state');
const WORK = join(TMP, 'work');
const HOME = join(TMP, 'home');
for (const dir of [RUN, STATE, WORK, HOME]) mkdirSync(dir, { recursive: true });

const SCRIPT = join(WORK, 'loop.sh');

const env = {
  ...process.env,
  DISPLAY: undefined,
  WAYLAND_DISPLAY: undefined,
  HOME,
  XDG_RUNTIME_DIR: RUN,
  XDG_STATE_HOME: STATE,
  CLIO_DEV: '1',
  CLIO_NO_UI_WATCH: '1',
};

const HANDSHAKE = join(RUN, 'clio', 'daemon.json');

let daemon = null;

async function startDaemon() {
  daemon = spawn(process.execPath, [join(ROOT, 'src', 'daemon', 'index.js')], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  daemon.stdout.on('data', (d) => log.push(String(d)));
  daemon.stderr.on('data', (d) => log.push(String(d)));

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (existsSync(HANDSHAKE)) {
      try {
        const info = JSON.parse(readFileSync(HANDSHAKE, 'utf8'));
        if (info.pid === daemon.pid) return info;
      } catch {
      }
    }
    await sleep(100);
  }
  throw new Error(`daemon did not start:\n${log.join('')}`);
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
      this.ws = new WebSocket(`ws://127.0.0.1:${this.info.port}/?token=${this.info.token}&c=${this.container}`, {
        origin,
      });
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

  tab(id) {
    return this.sessions.find((s) => s.id === id);
  }

  async await(pred, timeout = 6000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const hit = this.messages.find(pred);
      if (hit) return hit;
      await sleep(30);
    }
    return null;
  }

  async newTab() {
    const before = new Set(this.messages.filter((m) => m.t === 'created').map((m) => m.id));
    this.send({ t: 'create', cwd: WORK, cols: 80, rows: 24 });
    const tab = await this.await((m) => m.t === 'created' && !before.has(m.id));
    return tab?.id || null;
  }

  close() {
    this.ws.close();
  }
}

function savedState() {
  return JSON.parse(readFileSync(join(STATE, 'clio', 'state.json'), 'utf8'));
}

function savedExt(id) {
  return savedState().sessions.find((s) => s.id === id)?.ext ?? null;
}

function readsAFile() {
  console.log('1. what is a script and what only looks like one');

  const yes = [
    [['bash', 'scripts/build.sh'], 'scripts/build.sh'],
    [['bash', '-x', 'scripts/build.sh', '--once'], 'scripts/build.sh'],
    [['python3', '/home/me/bin/watch.py'], '/home/me/bin/watch.py'],
    [['./deploy.sh'], './deploy.sh'],
    [['/home/me/bin/watch'], '/home/me/bin/watch'],
    [['node', '--', 'server.js'], 'server.js'],
    [['agent.sh'], 'agent.sh'],
  ];
  for (const [argv, file] of yes) {
    const found = scriptIn(argv);
    check(`${argv.join(' ')}  →  ${file}`, found === file, String(found));
  }

  const no = [
    ['ansible-playbook', 'site.yml'],
    ['bash'],
    ['python3'],
    ['bash', '-c', 'while true; do date; sleep 5; done'],
    ['python3', '-m', 'http.server'],
    ['perl', '-e', 'print 1'],
    ['make', 'install'],
    ['git', 'log'],
  ];
  for (const argv of no) {
    check(`${argv.join(' ')}  →  not a script`, scriptIn(argv) === null, String(scriptIn(argv)));
  }
}

async function main() {
  readsAFile();

  copyFileSync(join(ROOT, 'test', 'fixtures', 'loop.sh'), SCRIPT);
  chmodSync(SCRIPT, 0o755);

  console.log(`\nsandbox at ${TMP}\n`);
  const info = await startDaemon();

  console.log('2. a script running in a tab, and an ordinary command next to it');
  const win = 'b'.repeat(8);
  const client = new Client(info, win);
  await client.connect();
  await client.await((m) => m.t === 'sessions');

  const scriptTab = await client.newTab();
  const plainTab = await client.newTab();
  check('a tab to run the script in', !!scriptTab);
  check('and one for an ordinary command', !!plainTab);
  if (!scriptTab || !plainTab) return report();

  await sleep(800);
  client.send({ t: 'input', id: scriptTab, data: `bash ${SCRIPT} nightly\n` });
  client.send({ t: 'input', id: plainTab, data: 'sleep 900\n' });
  await sleep(5000);

  const first = /RUNNING (\d+) (\w+)/.exec(client.output.get(scriptTab) || '');
  check('the script is running', !!first, JSON.stringify((client.output.get(scriptTab) || '').slice(-200)));
  check('with the argument it was given', first?.[2] === 'nightly', first?.[2]);

  console.log('\n3. the daemon writes down how it was started, before it needs it');
  check('the tab is marked as holding a script', client.tab(scriptTab)?.ext?.kind === 'script',
    JSON.stringify(client.tab(scriptTab)?.ext));
  check('the ordinary tab is not', client.tab(plainTab)?.ext === null,
    JSON.stringify(client.tab(plainTab)?.ext));

  const record = savedExt(scriptTab);
  check('the record is on disk', !!record, JSON.stringify(savedState().sessions.map((s) => s.ext)));
  check('under the adapter that found it', record?.kind === 'script');
  check('naming the file', record?.state?.file === SCRIPT, record?.state?.file);
  check(
    'with the whole command line, argument and all',
    JSON.stringify(record?.state?.argv) === JSON.stringify(['bash', SCRIPT, 'nightly']),
    JSON.stringify(record?.state?.argv),
  );

  console.log('\n4. the daemon is killed outright, and started again');
  client.close();
  daemon.kill('SIGKILL');
  await sleep(700);

  const info2 = await startDaemon();
  check('the daemon came back', !!info2.pid && info2.pid !== info.pid);

  const back = new Client(info2, win);
  await back.connect();
  await back.await((m) => m.t === 'sessions');
  back.send({ t: 'attach', id: scriptTab, cols: 80, rows: 24 });
  const replayed = (await back.await((m) => m.t === 'attached' && m.id === scriptTab))?.scrollback || '';
  check(
    'the seam says the script is being restarted',
    replayed.includes('restarting') && replayed.includes('loop.sh'),
    JSON.stringify(replayed.slice(-300)),
  );

  const again = await (async () => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const found = /RUNNING (\d+) (\w+)/.exec((back.output.get(scriptTab) || '').slice(replayed.length));
      if (found) return found;
      await sleep(200);
    }
    return null;
  })();
  const since = (back.output.get(scriptTab) || '').slice(replayed.length);
  check('and it is running again', !!again, JSON.stringify(since.slice(-300)));
  check('as a new run, not the old one', !!again && again[1] !== first?.[1], `${again?.[1]} vs ${first?.[1]}`);
  check('with the argument it had', again?.[2] === 'nightly', again?.[2]);
  check(
    'the command was typed into the new shell, in view',
    since.includes(`bash ${SCRIPT} nightly`),
    JSON.stringify(since.slice(-300)),
  );

  console.log('\n5. the tab next door is left alone');
  back.send({ t: 'attach', id: plainTab, cols: 80, rows: 24 });
  const plainReplay = (await back.await((m) => m.t === 'attached' && m.id === plainTab))?.scrollback || '';
  check(
    'an ordinary command is named, not re-run',
    plainReplay.includes('sleep 900') && plainReplay.includes('was not restarted'),
    JSON.stringify(plainReplay.slice(-200)),
  );

  console.log('\n6. stopping it is stopping it');
  await sleep(4000);
  back.send({ t: 'input', id: scriptTab, data: '\x03' });
  await sleep(5000);
  check('the tab stops claiming a script once it has gone',
    back.tab(scriptTab)?.ext === null, JSON.stringify(back.tab(scriptTab)?.ext));
  check('and the record is off the disk too', !savedExt(scriptTab),
    JSON.stringify(savedState().sessions.map((s) => s.ext)));

  back.send({ t: 'close', id: scriptTab });
  back.send({ t: 'close', id: plainTab });
  await sleep(600);
  back.close();

  report();
}

function report() {
  console.log(`\n${passed} passed, ${failed} failed`);
  cleanup();
  process.exit(failed ? 1 : 0);
}

function cleanup() {
  try {
    daemon?.kill('SIGKILL');
  } catch {
  }
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
  }
}

main().catch((err) => {
  console.error('test harness error:', err);
  console.error(log.join(''));
  cleanup();
  process.exit(1);
});
