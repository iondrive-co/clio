import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, copyFileSync, chmodSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';
import { spawnPty } from '../src/daemon/pty.js';
import { foregroundCommand, somethingInFront } from '../src/daemon/procinfo.js';

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

async function readsAProfile() {
  console.log('1. a shell in its profile, from /proc');

  const home = mkdtempSync(join(tmpdir(), 'clio-profile-proc-'));
  writeFileSync(
    join(home, '.bashrc'),
    ['sleep 0.8', 'eval "$(sleep 0.8; echo :)"', 'PS1="sandbox$ "'].join('\n'),
  );

  const term = spawnPty({ file: '/bin/bash', cwd: home, cols: 80, rows: 24, env: { ...process.env, HOME: home } });
  term.onData(() => {});

  const seen = [];
  const started = Date.now();
  while (Date.now() - started < 2600) {
    seen.push({
      at: Date.now() - started,
      fg: !!foregroundCommand(term.pid),
      front: !!somethingInFront(term.pid),
    });
    await sleep(40);
  }
  term.kill();

  const during = seen.filter((s) => s.at < 1500);
  const after = seen.filter((s) => s.at > 2100);

  check(
    'tpgid alone sees nothing at all while the profile runs',
    during.every((s) => !s.fg),
    `${during.filter((s) => s.fg).length} of ${during.length} samples saw a job`,
  );
  const [, ...running] = during;
  check(
    'the shell is nonetheless busy for every moment of it after the spawn',
    running.every((s) => s.front),
    `${running.filter((s) => !s.front).length} of ${running.length} samples said "at its prompt"`,
  );
  check(
    'and free once it reaches its prompt',
    after.length > 0 && after.every((s) => !s.front),
    `${after.filter((s) => s.front).length} of ${after.length} samples still said busy`,
  );

  rmSync(home, { recursive: true, force: true });
}

const TMP = mkdtempSync(join(tmpdir(), 'clio-profile-'));
const RUN = join(TMP, 'run');
const STATE = join(TMP, 'state');
const WORK = join(TMP, 'work');
const HOME = join(TMP, 'home');
for (const dir of [RUN, STATE, WORK, HOME]) mkdirSync(dir, { recursive: true });

const SCRIPT = join(WORK, 'loop.sh');
const ASK = join(HOME, 'ask-passphrase.sh');
const LOCK = join(HOME, 'agent-has-the-key');
const ANSWERS = join(HOME, 'answers');
const PASSPHRASE = 'open-sesame';

const env = {
  ...process.env,
  DISPLAY: undefined,
  WAYLAND_DISPLAY: undefined,
  HOME,
  SHELL: '/bin/bash',
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

  since(id, mark = 0) {
    return (this.output.get(id) || '').slice(mark);
  }

  async said(id, text, timeout = 8000, mark = 0) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (this.since(id, mark).includes(text)) return true;
      await sleep(100);
    }
    return false;
  }

  close() {
    this.ws.close();
  }
}

function answers() {
  try {
    return readFileSync(ANSWERS, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

async function main() {
  await readsAProfile();

  copyFileSync(join(ROOT, 'test', 'fixtures', 'loop.sh'), SCRIPT);
  chmodSync(SCRIPT, 0o755);
  copyFileSync(join(ROOT, 'test', 'fixtures', 'ask-passphrase.sh'), ASK);
  chmodSync(ASK, 0o755);

  writeFileSync(
    join(HOME, '.bashrc'),
    [`eval "$(${ASK})"`, 'PS1="sandbox$ "', ''].join('\n'),
  );

  console.log(`\nsandbox at ${TMP}\n`);
  const info = await startDaemon();

  console.log('2. two tabs, one of them holding something that will be resumed');
  const win = 'c'.repeat(8);
  const client = new Client(info, win);
  await client.connect();
  await client.await((m) => m.t === 'sessions');

  const scriptTab = await client.newTab();
  const plainTab = await client.newTab();
  const lastTab = await client.newTab();
  check('a tab to run the script in', !!scriptTab);
  check('and two behind it', !!plainTab && !!lastTab);
  if (!scriptTab || !plainTab || !lastTab) return report();

  const asked = await client.said(scriptTab, 'Enter passphrase', 8000);
  check('the first shell of the sandbox asks for the passphrase', asked,
    JSON.stringify(client.since(scriptTab).slice(-200)));
  client.send({ t: 'input', id: scriptTab, data: `${PASSPHRASE}\n` });
  check('and the key goes in', await client.said(scriptTab, 'sandbox$', 8000),
    JSON.stringify(client.since(scriptTab).slice(-200)));

  await sleep(500);
  client.send({ t: 'input', id: scriptTab, data: `bash ${SCRIPT} nightly\n` });
  const first = await (async () => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const found = /RUNNING (\d+) (\w+)/.exec(client.since(scriptTab));
      if (found) return found;
      await sleep(150);
    }
    return null;
  })();
  check('the script is running', !!first, JSON.stringify(client.since(scriptTab).slice(-200)));
  await sleep(3000);
  check('and the tab is on record as holding it', client.tab(scriptTab)?.ext?.kind === 'script',
    JSON.stringify(client.tab(scriptTab)?.ext));

  console.log('\n3. the daemon is killed, and the agent forgets the key');
  client.close();
  daemon.kill('SIGKILL');
  rmSync(LOCK, { force: true });
  rmSync(ANSWERS, { force: true });
  await sleep(700);

  const info2 = await startDaemon();
  check('the daemon came back', !!info2.pid && info2.pid !== info.pid);

  const back = new Client(info2, win);
  await back.connect();
  await back.await((m) => m.t === 'sessions');
  back.send({ t: 'attach', id: scriptTab, cols: 80, rows: 24 });
  const replayed = (await back.await((m) => m.t === 'attached' && m.id === scriptTab))?.scrollback || '';
  const mark = Math.max(0, replayed.lastIndexOf('new shell'));
  check('the seam says the script is being restarted', replayed.includes('restarting'),
    JSON.stringify(replayed.slice(-200)));

  console.log('\n4. the restored shell is asked for the passphrase, and is left alone until it is answered');
  const askedAgain = await back.said(scriptTab, 'Enter passphrase', 10000, mark);
  check('the lead shell asks', askedAgain, JSON.stringify(back.since(scriptTab, mark).slice(-200)));

  await sleep(4000);
  const waiting = back.since(scriptTab, mark);
  check(
    'the resume command is not typed while the question stands',
    !waiting.includes(`bash ${SCRIPT}`),
    JSON.stringify(waiting.slice(-300)),
  );
  check(
    'and nothing was offered to the key as a passphrase',
    answers().length === 0,
    JSON.stringify(answers()),
  );

  check(
    'the tab behind it is still waiting for a shell',
    back.tab(plainTab)?.status === 'restorable',
    `${back.tab(plainTab)?.status}`,
  );

  console.log('\n5. answered once, and the whole restore goes through on it');
  back.send({ t: 'input', id: scriptTab, data: `${PASSPHRASE}\n` });

  const again = await (async () => {
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      const found = /RUNNING (\d+) (\w+)/.exec(back.since(scriptTab, mark));
      if (found) return found;
      await sleep(200);
    }
    return null;
  })();
  check('the script is restarted once the profile is through', !!again,
    JSON.stringify(back.since(scriptTab, mark).slice(-300)));
  check('as a new run, not the old one', !!again && again[1] !== first?.[1], `${again?.[1]} vs ${first?.[1]}`);
  check('with the argument it had', again?.[2] === 'nightly', again?.[2]);
  check(
    'the command was typed after the answer, not before it',
    back.since(scriptTab, mark).indexOf(`bash ${SCRIPT}`) > back.since(scriptTab, mark).indexOf('Enter passphrase'),
    JSON.stringify(back.since(scriptTab, mark).slice(-300)),
  );

  const gotShell = await (async () => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (back.tab(plainTab)?.status === 'live') return true;
      await sleep(200);
    }
    return false;
  })();
  check('the tab behind it gets its shell', gotShell, `${back.tab(plainTab)?.status}`);
  back.send({ t: 'attach', id: plainTab, cols: 80, rows: 24 });
  const plainReplay = (await back.await((m) => m.t === 'attached' && m.id === plainTab))?.scrollback || '';
  check(
    'and its profile never asks, because the key is already in',
    !plainReplay.slice(plainReplay.lastIndexOf('new shell')).includes('Enter passphrase'),
    JSON.stringify(plainReplay.slice(-200)),
  );
  check(
    'so the passphrase was asked for once in the whole restore',
    answers().length === 1 && answers()[0] === PASSPHRASE,
    JSON.stringify(answers()),
  );

  console.log('\n6. an answer that does not take, and the tabs still come one at a time');
  back.close();
  daemon.kill('SIGKILL');
  rmSync(LOCK, { force: true });
  rmSync(ANSWERS, { force: true });
  await sleep(700);

  const info3 = await startDaemon();
  const three = new Client(info3, win);
  await three.connect();
  await three.await((m) => m.t === 'sessions');
  const inOrder = [scriptTab, plainTab, lastTab].sort((a, b) => (three.tab(a)?.order ?? 0) - (three.tab(b)?.order ?? 0));
  const [lead, second, third] = inOrder;
  for (const id of inOrder) three.send({ t: 'attach', id, cols: 80, rows: 24 });

  const leadAsks = await three.said(lead, 'Enter passphrase', 12000);
  check('the lead is asked', leadAsks, JSON.stringify(three.since(lead).slice(-200)));
  three.send({ t: 'input', id: lead, data: '\n' });

  const secondAsks = await three.said(second, 'Enter passphrase', 20000);
  check('the tab behind it follows, and is asked in its turn', secondAsks,
    `${three.tab(second)?.status}: ${JSON.stringify(three.since(second).slice(-200))}`);
  check(
    'and the one behind *that* has not been started',
    three.tab(third)?.status === 'restorable',
    `${three.tab(third)?.status}`,
  );

  three.send({ t: 'input', id: second, data: `${PASSPHRASE}\n` });
  const lastUp = await (async () => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (three.tab(third)?.status === 'live') return true;
      await sleep(250);
    }
    return false;
  })();
  check('and once it is answered the rest come back', lastUp, `${three.tab(third)?.status}`);
  three.close();

  console.log('\n7. a profile that never comes free, and the tabs behind it');
  daemon.kill('SIGKILL');
  writeFileSync(join(HOME, '.bashrc'), ['sleep 40', 'PS1="sandbox$ "', ''].join('\n'));
  await sleep(700);

  const info4 = await startDaemon();
  const held = new Client(info4, win);
  await held.connect();
  await held.await((m) => m.t === 'sessions');
  const stuckOrder = [scriptTab, plainTab, lastTab].sort((a, b) => (held.tab(a)?.order ?? 0) - (held.tab(b)?.order ?? 0));
  const [stuckLead, behind] = stuckOrder;

  await sleep(20000);
  check(
    'twenty seconds in, the lead still has the terminal and the tab behind it has no shell',
    held.tab(stuckLead)?.status === 'live' && held.tab(behind)?.status === 'restorable',
    `lead ${held.tab(stuckLead)?.status}, behind ${held.tab(behind)?.status}`,
  );

  const gaveUp = await (async () => {
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      if (held.tab(behind)?.status === 'live') return true;
      await sleep(250);
    }
    return false;
  })();
  check('the tab behind it gets its shell once the cap runs out', gaveUp, `${held.tab(behind)?.status}`);
  if (stuckLead === scriptTab) {
    held.send({ t: 'attach', id: scriptTab, cols: 80, rows: 24 });
    const stuck = (await held.await((m) => m.t === 'attached' && m.id === scriptTab))?.scrollback || '';
    check(
      'and the resume it could not type is named in the tab instead',
      stuck.slice(stuck.lastIndexOf('new shell')).includes('left for you'),
      JSON.stringify(stuck.slice(-300)),
    );
  }

  held.send({ t: 'close', id: scriptTab });
  held.send({ t: 'close', id: plainTab });
  held.send({ t: 'close', id: lastTab });
  await sleep(600);
  held.close();

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

process.on('unhandledRejection', (err) => {
  console.error(err);
  console.error(log.join(''));
  cleanup();
  process.exit(1);
});

main().catch((err) => {
  console.error(err);
  console.error(log.join(''));
  cleanup();
  process.exit(1);
});
