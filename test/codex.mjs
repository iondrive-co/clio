import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  appendFileSync,
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

import codex from '../src/agents/codex.js';

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

const TMP = mkdtempSync(join(tmpdir(), 'clio-codex-'));
const RUN = join(TMP, 'run');
const STATE = join(TMP, 'state');
const BIN = join(TMP, 'bin');
const WORK = join(TMP, 'work');
const HOME = join(TMP, 'home');
for (const dir of [RUN, STATE, BIN, WORK, HOME]) mkdirSync(dir, { recursive: true });

const THREAD_NAME = 'Handle Codex model overload';

const env = {
  ...process.env,
  DISPLAY: undefined,
  WAYLAND_DISPLAY: undefined,
  HOME,
  SHELL: '/bin/bash',
  PATH: `${BIN}:${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
  XDG_RUNTIME_DIR: RUN,
  XDG_STATE_HOME: STATE,
  CODEX_TEST_NAME: THREAD_NAME,
  CLIO_DEV: '1',
  CLIO_NO_UI_WATCH: '1',
};

const INDEX = join(HOME, '.codex', 'session_index.jsonl');

const HANDSHAKE = join(RUN, 'clio', 'daemon.json');

const RUNNING = 'codex --dangerously-bypass-approvals-and-sandbox';

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

// The adapter on its own: which commands are a codex worth following, and what
// the command to come back on that thread is.
function readsTheCommand() {
  console.log('1. what is a codex to follow, and what only looks like one');

  const yes = [
    ['codex'],
    ['codex', '--dangerously-bypass-approvals-and-sandbox'],
    ['codex', 'resume', '01a08106-af63-7811-90fb-565bf6e00384'],
    ['codex', 'resume', '--last'],
    ['codex', 'fix the build'],
    ['/home/me/.codex/packages/standalone/current/bin/codex'],
  ];
  for (const argv of yes) {
    check(`${argv.join(' ')}  →  a codex`, codex.matches({ argv, exe: null }), 'not matched');
  }

  const no = [
    ['codex', 'exec', 'do a thing'],
    ['codex', 'e'],
    ['codex', 'login'],
    ['codex', 'mcp-server'],
    ['codex', 'apply'],
    ['codex-code-mode-host'],
    ['claude'],
    ['ssh', 'if10'],
  ];
  for (const argv of no) {
    check(`${argv.join(' ')}  →  not one`, !codex.matches({ argv, exe: null }), 'matched');
  }

  console.log('\n2. what its terminal title says it is doing');

  const now = Date.now();
  const says = (termTitle, titleAt = now) => codex.activity({}, { termTitle, titleAt, now });

  // 0.154 blinks the marker between these two, twice a second, for as long as it
  // is blocked — so the title is never still and only what it says can be read.
  check('[ ! ] Action Required  →  waiting', says('[ ! ] Action Required | Add strategies | hermes') === 'waiting');
  check('[ . ] Action Required  →  waiting, blinked or not', says('[ . ] Action Required | Add strategies | hermes') === 'waiting');
  check('a braille frame  →  working', says('⠹ hermes') === 'working');
  check('and a braille frame in brackets  →  working too', says('[ ⠹ ] Working | Add strategies | hermes') === 'working');
  check('a title that has stood still  →  waiting', says('hermes', now - 3000) === 'waiting');
  check('a title that has just moved  →  no answer yet', says('hermes', now - 100) === null);
  check('no title at all  →  no answer', says(null) === null);

  console.log('\n3. coming back on a thread keeps the command it was given');

  const thread = '01a08106-af63-7811-90fb-565bf6e00384';
  const shapes = [
    [
      ['codex', '--dangerously-bypass-approvals-and-sandbox'],
      ['codex', 'resume', thread, '--dangerously-bypass-approvals-and-sandbox'],
    ],
    // a flag's value is not a flag, and dropping it makes a command that will not start
    [
      ['codex', '-C', '/tmp', '-c', 'model="o3"'],
      ['codex', 'resume', thread, '-C', '/tmp', '-c', 'model="o3"'],
    ],
    // the thread this tab is in now replaces the one the command asked for
    [
      ['codex', 'resume', 'deadbeef-0000-4000-8000-000000000000', '-C', '/tmp'],
      ['codex', 'resume', thread, '-C', '/tmp'],
    ],
    [['codex', 'resume', '--last'], ['codex', 'resume', thread]],
  ];
  for (const [was, want] of shapes) {
    const got = codex.resume({ v: 1, threadId: thread, argv: was }, { cwd: WORK }).argv;
    check(
      `${was.join(' ')}  →  ${want.join(' ')}`,
      JSON.stringify(got) === JSON.stringify(want),
      got.join(' '),
    );
  }

  const fresh = codex.resume({ v: 1, threadId: null, argv: ['codex', '--sandbox', 'danger-full-access'] }, { cwd: WORK });
  check(
    'a thread nothing was said in is started, not resumed',
    JSON.stringify(fresh.argv) === JSON.stringify(['codex', '--sandbox', 'danger-full-access']),
    fresh.argv.join(' '),
  );
}

async function main() {
  readsTheCommand();

  copyFileSync(join(ROOT, 'test', 'fixtures', 'codex'), join(BIN, 'codex'));
  chmodSync(join(BIN, 'codex'), 0o755);

  console.log(`\nsandbox at ${TMP}\n`);
  const info = await startDaemon();

  console.log('4. a codex in a tab, and an ordinary command next to it');
  const win = 'c'.repeat(8);
  const client = new Client(info, win);
  await client.connect();
  await client.await((m) => m.t === 'sessions');

  const codexTab = await client.newTab();
  const plainTab = await client.newTab();
  check('a tab to run codex in', !!codexTab);
  check('and one for an ordinary command', !!plainTab);
  if (!codexTab || !plainTab) return report();

  await sleep(800);
  client.send({ t: 'input', id: codexTab, data: `${RUNNING}\n` });
  client.send({ t: 'input', id: plainTab, data: 'sleep 900\n' });

  await sleep(5000);

  const started = /STARTED ([0-9a-f-]{36})/.exec(client.output.get(codexTab) || '');
  check(
    'codex started and opened a thread',
    !!started,
    JSON.stringify((client.output.get(codexTab) || '').slice(-200)),
  );
  const thread = started?.[1];

  console.log('\n5. the tab is named after the thread, not the directory');
  const named = await until(() => client.tab(codexTab)?.ext?.title === THREAD_NAME, 20000);
  check('the tab is marked as holding a codex', client.tab(codexTab)?.ext?.kind === 'codex',
    JSON.stringify(client.tab(codexTab)?.ext));
  check(
    `and carries the thread's name for the tab title — "${THREAD_NAME}"`,
    named,
    JSON.stringify(client.tab(codexTab)?.ext),
  );
  check('the ordinary tab is not a codex', client.tab(plainTab)?.ext === null,
    JSON.stringify(client.tab(plainTab)?.ext));

  const savedCodex = savedState().sessions.find((s) => s.id === codexTab)?.ext;
  check('the thread is written down, under the adapter that found it',
    savedCodex?.kind === 'codex' && savedCodex?.state?.threadId === thread,
    JSON.stringify(savedCodex));

  console.log('\n6. codex renames the thread, and the tab follows');
  const renamed = 'Audit completed plans boards';
  appendFileSync(
    INDEX,
    `${JSON.stringify({ id: thread, thread_name: renamed, updated_at: new Date().toISOString() })}\n`,
  );
  check(
    `the tab title becomes "${renamed}"`,
    await until(() => client.tab(codexTab)?.ext?.title === renamed, 20000),
    JSON.stringify(client.tab(codexTab)?.ext),
  );

  console.log('\n7. the daemon is killed outright, and started again');
  client.close();
  daemon.kill('SIGKILL');
  await sleep(700);

  const info2 = await startDaemon();
  check('the daemon came back', !!info2.pid && info2.pid !== info.pid);

  const back = new Client(info2, win);
  await back.connect();
  await back.await((m) => m.t === 'sessions');

  back.send({ t: 'attach', id: codexTab, cols: 80, rows: 24 });
  const replayed = (await back.await((m) => m.t === 'attached' && m.id === codexTab))?.scrollback || '';
  check(
    'the seam says the thread is being resumed',
    replayed.includes('resuming the Codex thread'),
    JSON.stringify(replayed.slice(-300)),
  );

  const resumed = await until(
    () => (back.output.get(codexTab) || '').includes(`RESUMED ${thread}`),
    20000,
  );
  const since = back.output.get(codexTab) || '';
  check('and codex came back on that same thread', resumed, JSON.stringify(since.slice(-300)));
  check(
    'the command it was resumed with is in view, with the flags it was started with',
    since.includes(`codex resume ${thread} --dangerously-bypass-approvals-and-sandbox`),
    JSON.stringify(since.slice(-300)),
  );

  console.log('\n8. a one-shot codex is not a thread to come back to');
  const oneShot = await back.newTab();
  await sleep(800);
  back.send({ t: 'input', id: oneShot, data: 'codex exec do a thing\n' });
  await sleep(6000);
  // The fixture is a node script, so the scripts adapter picks a one-shot up
  // where this one does not — what matters here is that no thread is followed
  // into a tab that was never in one.
  check(
    'a tab running `codex exec` is not followed as a thread',
    back.tab(oneShot)?.ext?.kind !== 'codex',
    JSON.stringify(back.tab(oneShot)?.ext),
  );

  back.send({ t: 'close', id: oneShot });
  back.send({ t: 'close', id: codexTab });
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
