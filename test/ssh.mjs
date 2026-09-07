import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';
import adapters from '../src/ssh/index.js';

const [ssh] = adapters;
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

function readsCommandLines() {
  console.log('1. finding the host in an ssh command line');

  const look = (line) => {
    const argv = line.split(' ');
    if (!ssh.matches({ argv, exe: '/usr/bin/ssh' })) return null;
    const state = ssh.capture({ argv });
    return { ...state, plan: ssh.resume(state) };
  };

  const cases = [
    ['ssh -o ControlMaster=no -L :9999:localhost:8500 safe@p-fsn-095.example.com',
      { host: 'p-fsn-095.example.com', user: 'safe', run: true }],
    ['ssh prod', { host: 'prod', user: null, run: true }],
    ['ssh -p 2222 me@box.example.com', { host: 'box.example.com', user: 'me', run: true }],
    ['ssh -p2222 me@box.example.com', { host: 'box.example.com', user: 'me', run: true }],
    ['ssh -NL 9999:localhost:8500 tunnel@gw', { host: 'gw', user: 'tunnel', run: true }],
    ['ssh -J bastion me@inner', { host: 'inner', user: 'me', run: true }],
    ['ssh -tt jump.example.com tmux attach', { host: 'jump.example.com', user: null, run: false }],
    ['ssh build-01 make deploy', { host: 'build-01', user: null, run: false }],
    ['ssh ssh://me@[2001:db8::1]:2200', { host: '2001:db8::1', user: 'me', run: true }],
  ];

  for (const [line, want] of cases) {
    const got = look(line);
    check(
      `${line}  →  ${want.host}${want.run ? '' : ' (not run)'}`,
      got?.host === want.host && got?.user === want.user && got?.plan?.run === want.run,
      JSON.stringify(got && { host: got.host, user: got.user, run: got.plan?.run }),
    );
  }

  const nothing = [
    'ssh',
    'ssh -O exit host',
    'ssh -G host',
    'ssh --nonsense host',
  ];
  for (const line of nothing) {
    check(`${line}  →  not a session`, !ssh.matches({ argv: line.split(' '), exe: '/usr/bin/ssh' }));
  }

  check(
    'sshfs is not ssh',
    !ssh.matches({ argv: ['sshfs', 'me@h:/', '/mnt'], exe: '/usr/bin/sshfs' }),
  );

  const spaced = ssh.capture({ argv: ['ssh', '-o', 'ProxyCommand=sleep 900', 'h'] });
  check('an argument with a space in it is kept whole', spaced.argv[2] === 'ProxyCommand=sleep 900',
    JSON.stringify(spaced.argv));
}

const TMP = mkdtempSync(join(tmpdir(), 'clio-ssh-'));
const RUN = join(TMP, 'run');
const STATE = join(TMP, 'state');
const WORK = join(TMP, 'work');
const HOME = join(TMP, 'home');
for (const dir of [RUN, STATE, WORK, HOME]) mkdirSync(dir, { recursive: true });

const env = {
  ...process.env,
  DISPLAY: undefined,
  WAYLAND_DISPLAY: undefined,
  SSH_ASKPASS_REQUIRE: undefined,
  HOME,
  PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
  XDG_RUNTIME_DIR: RUN,
  XDG_STATE_HOME: STATE,
  CLIO_DEV: '1',
  CLIO_NO_UI_WATCH: '1',
};

const HANDSHAKE = join(RUN, 'clio', 'daemon.json');

const HOST = 'p-fsn-095.test.invalid';
const DIALLED = `ssh -o "ProxyCommand=sleep 900" -o ControlMaster=no -L :9999:localhost:8500 safe@${HOST}`;
const WITH_COMMAND = `ssh -o "ProxyCommand=sleep 900" build-01.test.invalid make deploy`;

const HOST2 = 'i-hel-009.test.invalid';
const DIALLED2 = `ssh -o "ProxyCommand=sleep 900" ops@${HOST2}`;

const HOST3 = 'b-hel-001.test.invalid';
const ASKS = join(ROOT, 'test', 'fixtures', 'ask-code.sh');
const DIALLED3 = `ssh -o "ProxyCommand=${ASKS}" code@${HOST3}`;

const RESUME_GAP_MS = 12000;

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

  async until(id, pred, timeout = 12000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (pred(this.tab(id))) return true;
      await sleep(200);
    }
    return false;
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

function savedState() {
  return JSON.parse(readFileSync(join(STATE, 'clio', 'state.json'), 'utf8'));
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function pidsUnder(pid) {
  const found = [];
  const queue = [pid];
  while (queue.length) {
    const next = queue.shift();
    let kids = [];
    try {
      kids = readFileSync(`/proc/${next}/task/${next}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number);
    } catch {
    }
    for (const kid of kids) {
      found.push(kid);
      queue.push(kid);
    }
  }
  return found;
}

async function savedOnce(pred, timeout = 5000) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = savedState();
      if (pred(last)) return last;
    } catch {
    }
    await sleep(150);
  }
  return last ?? { sessions: [] };
}

async function said(client, id, text, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if ((client.output.get(id) || '').includes(text)) return true;
    await sleep(100);
  }
  return false;
}

function sinceRestore(client, id) {
  const seen = client.output.get(id) || '';
  const seam = seen.lastIndexOf('──── new shell');
  const below = seam === -1 ? -1 : seen.indexOf('\n', seam);
  return below === -1 ? '' : seen.slice(below);
}

async function saidSinceRestore(client, id, text, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (sinceRestore(client, id).includes(text)) return true;
    await sleep(100);
  }
  return false;
}

function watchFor(client, wanted) {
  const started = Date.now();
  const at = {};
  for (const id of Object.keys(wanted)) at[id] = Infinity;

  const look = () => {
    for (const [id, text] of Object.entries(wanted)) {
      if (Number.isFinite(at[id])) continue;
      if (sinceRestore(client, id).includes(text)) at[id] = Date.now() - started;
    }
    return Object.values(at).every(Number.isFinite);
  };

  const timer = setInterval(look, 100);
  timer.unref?.();

  return {
    async settled(timeout) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline && !look()) await sleep(100);
      clearInterval(timer);
      return at;
    },
  };
}

async function main() {
  readsCommandLines();

  if (!existsSync('/usr/bin/ssh')) {
    console.log('\nno ssh on this machine; the rest of this test needs the real one');
    return report();
  }

  console.log(`\nsandbox at ${TMP}`);
  const info = await startDaemon();

  console.log('\n2. a tab on a host is named after the host');
  const win = 'b'.repeat(8);
  const client = new Client(info, win);
  await client.connect();
  await client.await((m) => m.t === 'sessions');

  client.send({ t: 'create', cwd: WORK, cols: 80, rows: 24 });
  const codeTab = await client.await((m) => m.t === 'created');
  check('a tab on the host that asks for a code', !!codeTab);
  if (!codeTab) return report();

  client.send({ t: 'create', cwd: WORK, cols: 80, rows: 24 });
  const sshTab = await client.await((m) => m.t === 'created' && m.id !== codeTab.id);
  check('a tab to hold the connection', !!sshTab);
  if (!sshTab) return report();

  client.send({ t: 'create', cwd: WORK, cols: 80, rows: 24 });
  const workTab = await client.await(
    (m) => m.t === 'created' && m.id !== codeTab.id && m.id !== sshTab.id,
  );
  check('and one to run something over ssh', !!workTab);

  client.send({ t: 'create', cwd: WORK, cols: 80, rows: 24 });
  const otherTab = await client.await(
    (m) => m.t === 'created' && m.id !== codeTab.id && m.id !== sshTab.id && m.id !== workTab.id,
  );
  check('and one on a second host', !!otherTab);
  if (!otherTab) return report();

  await sleep(800);
  client.send({ t: 'input', id: codeTab.id, data: `${DIALLED3}\n` });
  client.send({ t: 'input', id: sshTab.id, data: `${DIALLED}\n` });
  client.send({ t: 'input', id: workTab.id, data: `${WITH_COMMAND}\n` });
  client.send({ t: 'input', id: otherTab.id, data: `${DIALLED2}\n` });

  const named = await client.until(sshTab.id, (t) => t?.ext?.title === HOST);
  check('the tab calls itself by the host', named, JSON.stringify(client.tab(sshTab.id)?.ext));
  check('under the ssh extension', client.tab(sshTab.id)?.ext?.kind === 'ssh');

  console.log('\n3. the daemon writes down how it was dialled, before it needs it');
  const saved = await savedOnce((s) => s.sessions.every((t) => t.id !== workTab.id || t.ext));
  const record = saved.sessions.find((s) => s.id === sshTab.id)?.ext;
  check('the record is on disk', record?.kind === 'ssh', JSON.stringify(record));
  check('naming the host', record?.state?.host === HOST, JSON.stringify(record?.state?.host));
  check('and the user on it', record?.state?.user === 'safe', JSON.stringify(record?.state?.user));
  check(
    'with the whole command line, forward and all',
    record?.state?.argv?.includes('-L') &&
      record?.state?.argv?.includes(':9999:localhost:8500') &&
      record?.state?.argv?.includes('ProxyCommand=sleep 900'),
    JSON.stringify(record?.state?.argv),
  );
  check(
    'the one with a command after the host knows it is not a plain session',
    saved.sessions.find((s) => s.id === workTab.id)?.ext?.state?.remote === true,
    JSON.stringify(saved.sessions.find((s) => s.id === workTab.id)?.ext?.state),
  );

  console.log('\n4. the daemon is killed outright, and started again');
  const oldShell = client.tab(sshTab.id)?.pid;
  const oldSsh = pidsUnder(oldShell);
  check('the tab had a shell with an ssh under it', !!oldShell && oldSsh.length > 0,
    `${oldShell}: ${JSON.stringify(oldSsh)}`);

  client.close();
  daemon.kill('SIGKILL');
  await sleep(700);

  const info2 = await startDaemon();
  check('the daemon came back', !!info2.pid && info2.pid !== info.pid);

  await sleep(1500);
  check(
    'the shell from before the crash is gone',
    !alive(oldShell),
    `${oldShell} is still running`,
  );
  check(
    'and the ssh that was under it',
    oldSsh.every((p) => !alive(p)),
    JSON.stringify(oldSsh.filter(alive)),
  );

  const back = new Client(info2, win);
  await back.connect();
  await back.await((m) => m.t === 'sessions');

  back.send({ t: 'attach', id: codeTab.id, cols: 80, rows: 24 });
  back.send({ t: 'attach', id: sshTab.id, cols: 80, rows: 24 });
  back.send({ t: 'attach', id: otherTab.id, cols: 80, rows: 24 });
  await back.await((m) => m.t === 'attached' && m.id === otherTab.id);
  const dialledAt = watchFor(back, {
    [sshTab.id]: `safe@${HOST}`,
    [otherTab.id]: `ops@${HOST2}`,
  });

  const replayed = (await back.await((m) => m.t === 'attached' && m.id === sshTab.id))?.scrollback || '';
  check(
    'the seam says which host is being dialled again',
    replayed.includes(`reconnecting to safe@${HOST}`),
    JSON.stringify(replayed.slice(-300)),
  );

  console.log('\n4b. nothing else is dialled until the first tab has been answered');
  check(
    'the first tab back is the one stopped at a question',
    await saidSinceRestore(back, codeTab.id, 'Verification code:', 20000),
    JSON.stringify(sinceRestore(back, codeTab.id).slice(-200)),
  );

  await sleep(RESUME_GAP_MS + 4000);
  check(
    'the tab behind it has not been dialled, gap or no gap',
    !sinceRestore(back, sshTab.id).includes(`safe@${HOST}`),
    JSON.stringify(sinceRestore(back, sshTab.id).slice(-200)),
  );
  check(
    'and neither has the one behind that',
    !sinceRestore(back, otherTab.id).includes(`ops@${HOST2}`),
    JSON.stringify(sinceRestore(back, otherTab.id).slice(-200)),
  );

  const everRed = (id) =>
    back.messages.some(
      (m) => m.t === 'sessions' && m.sessions.find((s) => s.id === id)?.unseenOutput,
    );
  check('the tab holding the question went red, so it could be found', everRed(codeTab.id));
  check('and the tabs waiting behind it did not', !everRed(otherTab.id) && !everRed(sshTab.id));

  const answeredAt = Date.now();
  back.send({ t: 'input', id: codeTab.id, data: '424242\r' });
  const released = await saidSinceRestore(back, sshTab.id, `safe@${HOST}`, 20000);
  check('and once it is answered the next one goes', released,
    JSON.stringify(sinceRestore(back, sshTab.id).slice(-200)));
  check(
    'without waiting out another gap first',
    released && Date.now() - answeredAt < RESUME_GAP_MS,
    `${Math.round((Date.now() - answeredAt) / 100) / 10}s after the code`,
  );

  console.log('\n4c. the tab comes back on the connection it was dialled with');
  const typed = await (async () => {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      const seen = back.output.get(sshTab.id) || '';
      if (seen.includes(`safe@${HOST}`) && seen.includes(':9999:localhost:8500')) return seen;
      await sleep(200);
    }
    return null;
  })();
  check('the same command was typed into the new shell, in view', !!typed,
    JSON.stringify((back.output.get(sshTab.id) || '').slice(-300)));
  check(
    'including the argument that had a space in it, quoted so the shell reads it back whole',
    (typed || '').includes(`'ProxyCommand=sleep 900'`),
    JSON.stringify((typed || '').slice(-300)),
  );

  const running = await back.until(
    sshTab.id,
    (t) => t?.command?.includes(HOST) && t?.ext?.title === HOST,
  );
  check('and ssh is running in the tab again, on the same host', running,
    JSON.stringify(back.tab(sshTab.id)));

  console.log('\n4d. two connections are not dialled at once');
  const spacing = await dialledAt.settled(70000);
  check('the first host was dialled', Number.isFinite(spacing[sshTab.id]), JSON.stringify(spacing));
  check('and so was the second', Number.isFinite(spacing[otherTab.id]), JSON.stringify(spacing));
  check(
    'but not until the first had had the terminal to itself',
    spacing[otherTab.id] - spacing[sshTab.id] > 5000,
    `${Math.round((spacing[otherTab.id] - spacing[sshTab.id]) / 100) / 10}s apart`,
  );

  console.log('\n5. the one that was running a command is not run');
  back.send({ t: 'attach', id: workTab.id, cols: 80, rows: 24 });
  const workReplay = (await back.await((m) => m.t === 'attached' && m.id === workTab.id))?.scrollback || '';
  check(
    'the seam says it is there but has not been run',
    workReplay.includes('at the prompt, not run'),
    JSON.stringify(workReplay.slice(-300)),
  );

  await sleep(5000);
  const idle = back.tab(workTab.id);
  check('nothing is running in that tab', !idle?.command, JSON.stringify(idle?.command));
  check(
    'but the command is sitting at the prompt, waiting for a person',
    (back.output.get(workTab.id) || '').includes('make deploy'),
    JSON.stringify((back.output.get(workTab.id) || '').slice(-200)),
  );

  console.log('\n6. leaving the host is leaving the host');
  back.send({ t: 'input', id: sshTab.id, data: '\u0003' });
  const forgotten = await back.until(sshTab.id, (t) => t?.ext === null);
  check('the tab stops claiming a host once ssh has gone', forgotten,
    JSON.stringify(back.tab(sshTab.id)?.ext));
  const after = await savedOnce((s) => !s.sessions.find((t) => t.id === sshTab.id)?.ext);
  check(
    'and the record is off the disk too',
    !after.sessions.find((s) => s.id === sshTab.id)?.ext,
    JSON.stringify(after.sessions.map((s) => s.ext)),
  );
  check(
    'so the tab goes back to being named after its directory',
    !back.tab(sshTab.id)?.ext?.title,
    JSON.stringify(back.tab(sshTab.id)?.ext),
  );

  console.log('\n7. a window put away is put away under the host');
  back.send({ t: 'input', id: sshTab.id, data: `${DIALLED}\n` });
  const again = await back.until(sshTab.id, (t) => t?.ext?.title === HOST);
  check('the tab is on the host again', again, JSON.stringify(back.tab(sshTab.id)?.ext));

  back.close();
  await sleep(12000);
  const parked = await savedOnce((s) => s.containers.some((c) => c.closedAt));
  const group = parked.containers.find((c) => c.id === win);
  check('the window was kept rather than ended', !!group?.closedAt, JSON.stringify(group));
  check('under the name of the host its first tab is on', group?.name === HOST3,
    JSON.stringify(group?.name));
  check('and marked as a name clio chose, not one somebody typed', group?.named === false,
    JSON.stringify(group?.named));

  const final = new Client(info2, win);
  await final.connect();
  await final.await((m) => m.t === 'sessions');

  console.log('\n8. the passphrase is asked for in the tab, not on the desktop');
  final.send({ t: 'create', cwd: WORK, cols: 80, rows: 24 });
  const askTab = await final.await((m) => m.t === 'created');
  check('a tab to ask in', !!askTab);
  if (askTab) {
    await sleep(800);
    final.send({ t: 'input', id: askTab.id, data: 'echo "clio-askpass=[$SSH_ASKPASS_REQUIRE]"\n' });
    check(
      'the shell is told to ask on its own terminal',
      await said(final, askTab.id, 'clio-askpass=[never]'),
      JSON.stringify((final.output.get(askTab.id) || '').slice(-200)),
    );
    final.send({ t: 'close', id: askTab.id });
  }

  final.send({ t: 'close', id: sshTab.id });
  final.send({ t: 'close', id: workTab.id });
  final.send({ t: 'close', id: otherTab.id });
  await sleep(600);
  final.close();

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
