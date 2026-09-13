import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
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

import antigravity from '../src/agents/antigravity.js';

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

const TMP = mkdtempSync(join(tmpdir(), 'clio-antigravity-'));
const RUN = join(TMP, 'run');
const STATE = join(TMP, 'state');
const BIN = join(TMP, 'bin');
const WORK = join(TMP, 'work');
const HOME = join(TMP, 'home');
const AGY_HOME = join(HOME, '.gemini', 'antigravity-cli');
for (const dir of [RUN, STATE, BIN, WORK, HOME, AGY_HOME]) mkdirSync(dir, { recursive: true });

const SESSION_NAME = 'Fix Antigravity Tab Title';

const env = {
  ...process.env,
  DISPLAY: undefined,
  WAYLAND_DISPLAY: undefined,
  HOME,
  SHELL: '/bin/bash',
  PATH: `${BIN}:${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
  XDG_RUNTIME_DIR: RUN,
  XDG_STATE_HOME: STATE,
  ANTIGRAVITY_HOME: AGY_HOME,
  ANTIGRAVITY_TEST_NAME: SESSION_NAME,
  CLIO_DEV: '1',
  CLIO_NO_UI_WATCH: '1',
};

const HANDSHAKE = join(RUN, 'clio', 'daemon.json');

const RUNNING = 'agy --dangerously-skip-permissions';

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

async function until(pred, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(150);
  }
  return false;
}

function savedState() {
  return JSON.parse(readFileSync(join(STATE, 'clio', 'state.json'), 'utf8'));
}

function readsTheCommand() {
  console.log('1. what is an antigravity session to follow, and what only looks like one');

  const yes = [
    ['agy'],
    ['agy', '--dangerously-skip-permissions'],
    ['agy', '--conversation', '01a08106-af63-7811-90fb-565bf6e00384'],
    ['agy', '--conversation=01a08106-af63-7811-90fb-565bf6e00384'],
    ['agy', '-c'],
    ['agy', '--continue'],
    ['agy', '-i', 'fix the build'],
    ['antigravity'],
    ['/home/me/.local/bin/agy'],
  ];
  for (const argv of yes) {
    check(`${argv.join(' ')}  →  an antigravity session`, antigravity.matches({ argv, exe: null }), 'not matched');
  }

  const no = [
    ['agy', 'agent'],
    ['agy', 'agents'],
    ['agy', 'changelog'],
    ['agy', 'help'],
    ['agy', 'install'],
    ['agy', 'mcp'],
    ['agy', 'mic-serve'],
    ['agy', 'models'],
    ['agy', 'plugin'],
    ['agy', 'plugins'],
    ['agy', 'remote-control'],
    ['agy', 'update'],
    ['agy', '-p', 'hello'],
    ['agy', '--print', 'hello'],
    ['agy', '--prompt', 'hello'],
    ['claude'],
    ['codex'],
    ['ssh', 'if10'],
  ];
  for (const argv of no) {
    check(`${argv.join(' ')}  →  not one`, !antigravity.matches({ argv, exe: null }), 'matched');
  }

  console.log('\n2. coming back on a session keeps the command it was given');

  const conversation = '01a08106-af63-7811-90fb-565bf6e00384';
  const shapes = [
    [
      ['agy', '--dangerously-skip-permissions'],
      ['agy', '--conversation', conversation, '--dangerously-skip-permissions'],
    ],
    [
      ['agy', '--model', 'gemini-2.5-pro'],
      ['agy', '--conversation', conversation, '--model', 'gemini-2.5-pro'],
    ],
    [
      ['agy', '--conversation', 'deadbeef-0000-4000-8000-000000000000', '--effort', 'high'],
      ['agy', '--conversation', conversation, '--effort', 'high'],
    ],
    [
      ['agy', '--conversation=deadbeef-0000-4000-8000-000000000000'],
      ['agy', '--conversation', conversation],
    ],
    [['agy', '-c'], ['agy', '--conversation', conversation]],
    [['agy', '--continue'], ['agy', '--conversation', conversation]],
  ];
  for (const [was, want] of shapes) {
    const got = antigravity.resume({ v: 1, conversationId: conversation, argv: was }, { cwd: WORK }).argv;
    check(
      `${was.join(' ')}  →  ${want.join(' ')}`,
      JSON.stringify(got) === JSON.stringify(want),
      got.join(' '),
    );
  }

  const fresh = antigravity.resume({ v: 1, conversationId: null, argv: ['agy', '--dangerously-skip-permissions'] }, { cwd: WORK });
  check(
    'a session nothing was said in is started, not resumed',
    JSON.stringify(fresh.argv) === JSON.stringify(['agy', '--dangerously-skip-permissions']),
    fresh.argv.join(' '),
  );
}

async function main() {
  readsTheCommand();

  copyFileSync(join(ROOT, 'test', 'fixtures', 'agy'), join(BIN, 'agy'));
  chmodSync(join(BIN, 'agy'), 0o755);

  console.log(`\nsandbox at ${TMP}\n`);
  const info = await startDaemon();

  console.log('3. an antigravity session in a tab, and an ordinary command next to it');
  const win = 'd'.repeat(8);
  const client = new Client(info, win);
  await client.connect();
  await client.await((m) => m.t === 'sessions');

  const agyTab = await client.newTab();
  const plainTab = await client.newTab();
  check('a tab to run antigravity in', !!agyTab);
  check('and one for an ordinary command', !!plainTab);
  if (!agyTab || !plainTab) return report();

  await sleep(800);
  client.send({ t: 'input', id: agyTab, data: `${RUNNING}\n` });
  client.send({ t: 'input', id: plainTab, data: 'sleep 900\n' });

  await sleep(5000);

  const started = /STARTED ([0-9a-f-]{36})/.exec(client.output.get(agyTab) || '');
  check(
    'antigravity started and opened a session',
    !!started,
    JSON.stringify((client.output.get(agyTab) || '').slice(-200)),
  );
  const conversation = started?.[1];

  console.log('\n4. the tab is named after the conversation, not the directory');
  const named = await until(() => client.tab(agyTab)?.ext?.title === SESSION_NAME, 20000);
  check('the tab is marked as holding an antigravity session', client.tab(agyTab)?.ext?.kind === 'antigravity',
    JSON.stringify(client.tab(agyTab)?.ext));
  check(
    `and carries the conversation's name for the tab title — "${SESSION_NAME}"`,
    named,
    JSON.stringify(client.tab(agyTab)?.ext),
  );
  check('the ordinary tab is not antigravity', client.tab(plainTab)?.ext === null,
    JSON.stringify(client.tab(plainTab)?.ext));

  const savedAgy = savedState().sessions.find((s) => s.id === agyTab)?.ext;
  check('the session is written down, under the adapter that found it',
    savedAgy?.kind === 'antigravity' && savedAgy?.state?.conversationId === conversation,
    JSON.stringify(savedAgy));

  console.log('\n5. antigravity renames the conversation, and the tab follows');
  const renamed = 'Fix Antigravity Tab Title - Renamed';
  writeFileSync(
    join(AGY_HOME, 'annotations', `${conversation}.pbtxt`),
    `title:"${renamed}"\n`,
  );
  check(
    `the tab title becomes "${renamed}"`,
    await until(() => client.tab(agyTab)?.ext?.title === renamed, 20000),
    JSON.stringify(client.tab(agyTab)?.ext),
  );

  console.log('\n6. the daemon is killed outright, and started again');
  client.close();
  daemon.kill('SIGKILL');
  await sleep(700);

  const info2 = await startDaemon();
  check('the daemon came back', !!info2.pid && info2.pid !== info.pid);

  const back = new Client(info2, win);
  await back.connect();
  await back.await((m) => m.t === 'sessions');

  back.send({ t: 'attach', id: agyTab, cols: 80, rows: 24 });
  const replayed = (await back.await((m) => m.t === 'attached' && m.id === agyTab))?.scrollback || '';
  check(
    'the seam says the session is being resumed',
    replayed.includes('resuming the Antigravity session'),
    JSON.stringify(replayed.slice(-300)),
  );

  const resumed = await until(
    () => (back.output.get(agyTab) || '').includes(`RESUMED ${conversation}`),
    20000,
  );
  const since = back.output.get(agyTab) || '';
  check('and antigravity came back on that same conversation', resumed, JSON.stringify(since.slice(-300)));
  check(
    'the command it was resumed with is in view, with the flags it was started with',
    since.includes(`agy --conversation ${conversation} --dangerously-skip-permissions`),
    JSON.stringify(since.slice(-300)),
  );

  console.log('\n7. a one-shot antigravity command is not a session to come back to');
  const oneShot = await back.newTab();
  await sleep(800);
  back.send({ t: 'input', id: oneShot, data: 'agy -p "do a thing"\n' });
  await sleep(6000);
  check(
    'a tab running `agy -p` is not followed as a session',
    back.tab(oneShot)?.ext?.kind !== 'antigravity',
    JSON.stringify(back.tab(oneShot)?.ext),
  );

  back.send({ t: 'close', id: oneShot });
  back.send({ t: 'close', id: agyTab });
  back.send({ t: 'close', id: plainTab });
  await sleep(600);
  back.close();

  report();
}

function report() {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) console.log(log.join(''));
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
