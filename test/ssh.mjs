/*
 * The host a tab was on.
 *
 * Two things are being tested, and they are the two halves of the extension:
 * that a tab holding an ssh session is named after the host rather than after
 * `ssh`, and that when the daemon dies the tab comes back on the same
 * connection — dialled with the arguments it was dialled with the first time,
 * port forwards and all. And one thing that must *not* happen: an ssh with a
 * command on the end of it is work, not a connection, and clio does not press
 * Enter on somebody's deploy.
 *
 * The ssh here is the real one, which is the point: the adapter reads /proc,
 * and a stand-in on the PATH would only prove that clio can recognise a stand-in
 * on the PATH. It never reaches the network. `-o ProxyCommand=sleep 900` hands
 * ssh a pipe that nothing will ever say hello down, so it sits in the foreground
 * of the tab waiting for a banner, which is exactly the shape of process this
 * has to notice. Nothing is resolved, nothing is connected to, and the host name
 * used is in .invalid, which by RFC 2606 is nobody's.
 *
 * Runs a clio of its own, on its own state, with a home of its own: nothing
 * here touches the daemon anybody is working in.
 *
 *   node test/ssh.mjs
 */
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

/** Everything the sandbox daemon says, kept for when something goes wrong. */
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

/* ------------------------------------------------- 1. reading a command line */

/*
 * Before any of it can work, the destination has to be found in among the
 * options — and an option's value must never be mistaken for it. A tab named
 * after a port number would be worse than a tab named `ssh`.
 */
function readsCommandLines() {
  console.log('1. finding the host in an ssh command line');

  const look = (line) => {
    const argv = line.split(' ');
    if (!ssh.matches({ argv, exe: '/usr/bin/ssh' })) return null;
    const state = ssh.capture({ argv });
    return { ...state, plan: ssh.resume(state) };
  };

  const cases = [
    // the whole point of the exercise
    ['ssh -o ControlMaster=no -L :9999:localhost:8500 safe@p-fsn-095.example.com',
      { host: 'p-fsn-095.example.com', user: 'safe', run: true }],
    ['ssh prod', { host: 'prod', user: null, run: true }],
    // a value that looks like a host, attached and detached
    ['ssh -p 2222 me@box.example.com', { host: 'box.example.com', user: 'me', run: true }],
    ['ssh -p2222 me@box.example.com', { host: 'box.example.com', user: 'me', run: true }],
    // clustered flags, the last of which takes the next word
    ['ssh -NL 9999:localhost:8500 tunnel@gw', { host: 'gw', user: 'tunnel', run: true }],
    ['ssh -J bastion me@inner', { host: 'inner', user: 'me', run: true }],
    // a command on the end is work: remembered, not run
    ['ssh -tt jump.example.com tmux attach', { host: 'jump.example.com', user: null, run: false }],
    ['ssh build-01 make deploy', { host: 'build-01', user: null, run: false }],
    // the URI form, brackets and port off the name
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
    'ssh', // no host: ssh printing its usage
    'ssh -O exit host', // a control command aimed at somebody else's connection
    'ssh -G host', // a question that prints an answer and exits
    'ssh --nonsense host', // a version of ssh this does not know
  ];
  for (const line of nothing) {
    check(`${line}  →  not a session`, !ssh.matches({ argv: line.split(' '), exe: '/usr/bin/ssh' }));
  }

  check(
    'sshfs is not ssh',
    !ssh.matches({ argv: ['sshfs', 'me@h:/', '/mnt'], exe: '/usr/bin/sshfs' }),
  );

  // What goes back into the shell has to be what came out of /proc, spaces and
  // all — an argument that was quoted when it was typed has to be quoted again.
  const spaced = ssh.capture({ argv: ['ssh', '-o', 'ProxyCommand=sleep 900', 'h'] });
  check('an argument with a space in it is kept whole', spaced.argv[2] === 'ProxyCommand=sleep 900',
    JSON.stringify(spaced.argv));
}

/* ---------------------------------------------------------------- a sandbox */

const TMP = mkdtempSync(join(tmpdir(), 'clio-ssh-'));
const RUN = join(TMP, 'run');
const STATE = join(TMP, 'state');
const WORK = join(TMP, 'work');
const HOME = join(TMP, 'home');
for (const dir of [RUN, STATE, WORK, HOME]) mkdirSync(dir, { recursive: true });

// A home of its own, so that ssh reads no config of anybody's and clio writes
// its state where nothing else is looking.
const env = {
  ...process.env,
  // Nothing here asks for a window, and nothing here may put one on somebody's
  // desktop by accident either.
  DISPLAY: undefined,
  WAYLAND_DISPLAY: undefined,
  HOME,
  PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
  XDG_RUNTIME_DIR: RUN,
  XDG_STATE_HOME: STATE,
  // Says "sandbox" in the window title, and keeps this away from the real one.
  CLIO_DEV: '1',
  CLIO_NO_UI_WATCH: '1',
};

const HANDSHAKE = join(RUN, 'clio', 'daemon.json');

/*
 * The connection that is never made. ProxyCommand hands ssh a pipe that will
 * never carry a banner, so it waits in the foreground exactly as a real session
 * does; the host is in .invalid and is never looked up.
 */
const HOST = 'p-fsn-095.test.invalid';
const DIALLED = `ssh -o "ProxyCommand=sleep 900" -o ControlMaster=no -L :9999:localhost:8500 safe@${HOST}`;
const WITH_COMMAND = `ssh -o "ProxyCommand=sleep 900" build-01.test.invalid make deploy`;

let daemon = null;

/**
 * A daemon of this test's own, and proof that it is listening.
 *
 * A killed daemon leaves its handshake file behind, so the file existing is not
 * the signal — the pid in it being this process's child is.
 */
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
        /* half-written; look again */
      }
    }
    await sleep(100);
  }
  throw new Error(`daemon did not start:\n${log.join('')}`);
}

/** A stand-in for a window. */
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

  /** Wait for the tabs to say something in particular, since the poll is slow. */
  async until(id, pred, timeout = 12000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (pred(this.tab(id))) return true;
      await sleep(200);
    }
    return false;
  }

  close() {
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

/** Everything running under a shell, however deep. */
function pidsUnder(pid) {
  const found = [];
  const queue = [pid];
  while (queue.length) {
    const next = queue.shift();
    let kids = [];
    try {
      kids = readFileSync(`/proc/${next}/task/${next}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number);
    } catch {
      /* gone */
    }
    for (const kid of kids) {
      found.push(kid);
      queue.push(kid);
    }
  }
  return found;
}

/**
 * The state file, once it has caught up with what the tabs are saying.
 *
 * Saving is debounced, so a broadcast arrives a fraction of a second before the
 * file it came from is written. Reading on the heels of one is reading the
 * state before last.
 */
async function savedOnce(pred, timeout = 5000) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = savedState();
      if (pred(last)) return last;
    } catch {
      /* mid-rename; look again */
    }
    await sleep(150);
  }
  return last ?? { sessions: [] };
}

/* ------------------------------------------------------------------- the test */

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
  const sshTab = await client.await((m) => m.t === 'created');
  check('a tab to hold the connection', !!sshTab);
  if (!sshTab) return report();

  client.send({ t: 'create', cwd: WORK, cols: 80, rows: 24 });
  const workTab = await client.await((m) => m.t === 'created' && m.id !== sshTab.id);
  check('and one to run something over ssh', !!workTab);

  await sleep(800);
  client.send({ t: 'input', id: sshTab.id, data: `${DIALLED}\n` });
  client.send({ t: 'input', id: workTab.id, data: `${WITH_COMMAND}\n` });

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

  // ---- the part that matters ---------------------------------------------
  console.log('\n4. the daemon is killed outright, and started again');
  // Held on to across the crash: a shell that survives it goes on holding the
  // forward the reconnect is about to ask for. See SessionManager.clearStrays.
  const oldShell = client.tab(sshTab.id)?.pid;
  const oldSsh = pidsUnder(oldShell);
  check('the tab had a shell with an ssh under it', !!oldShell && oldSsh.length > 0,
    `${oldShell}: ${JSON.stringify(oldSsh)}`);

  client.close();
  daemon.kill('SIGKILL');
  await sleep(700);

  const info2 = await startDaemon();
  check('the daemon came back', !!info2.pid && info2.pid !== info.pid);

  // Nothing from the last life is still running. Without this the old ssh keeps
  // the local port it forwarded, and the reconnected session comes up without
  // its tunnel — a tab that looks right and is not.
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

  back.send({ t: 'attach', id: sshTab.id, cols: 80, rows: 24 });
  const replayed = (await back.await((m) => m.t === 'attached' && m.id === sshTab.id))?.scrollback || '';
  check(
    'the seam says which host is being dialled again',
    replayed.includes(`reconnecting to safe@${HOST}`),
    JSON.stringify(replayed.slice(-300)),
  );

  // Typed into the shell rather than exec'd around it, so the terminal echoes
  // it: what happened here is legible to whoever opens the tab, and repeatable
  // from its history.
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

  // The proof that it ran is not the echo, it is a process: ssh is in the
  // foreground of that tab again, and the tab is named after the host again.
  const running = await back.until(
    sshTab.id,
    (t) => t?.command?.includes(HOST) && t?.ext?.title === HOST,
  );
  check('and ssh is running in the tab again, on the same host', running,
    JSON.stringify(back.tab(sshTab.id)));

  console.log('\n5. the one that was running a command is not run');
  back.send({ t: 'attach', id: workTab.id, cols: 80, rows: 24 });
  const workReplay = (await back.await((m) => m.t === 'attached' && m.id === workTab.id))?.scrollback || '';
  check(
    'the seam says it is there but has not been run',
    workReplay.includes('at the prompt, not run'),
    JSON.stringify(workReplay.slice(-300)),
  );

  // Long enough for it to have started if it were going to, and for two polls.
  await sleep(5000);
  const idle = back.tab(workTab.id);
  check('nothing is running in that tab', !idle?.command, JSON.stringify(idle?.command));
  check(
    'but the command is sitting at the prompt, waiting for a person',
    (back.output.get(workTab.id) || '').includes('make deploy'),
    JSON.stringify((back.output.get(workTab.id) || '').slice(-200)),
  );

  console.log('\n6. leaving the host is leaving the host');
  // A record that outlived the process would be a tab that dials a machine
  // somebody deliberately logged out of.
  back.send({ t: 'input', id: sshTab.id, data: '\u0003' }); // Ctrl-C
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
  // Closing a window keeps its shells under a name, and that name is what the
  // picker offers days later. A window whose first tab is on a machine in
  // Falkenstein should not be offered as the directory it was opened from.
  back.send({ t: 'input', id: sshTab.id, data: `${DIALLED}\n` });
  const again = await back.until(sshTab.id, (t) => t?.ext?.title === HOST);
  check('the tab is on the host again', again, JSON.stringify(back.tab(sshTab.id)?.ext));

  // A window is put away when its last client goes and does not come back.
  back.close();
  await sleep(12000);
  const parked = await savedOnce((s) => s.containers.some((c) => c.closedAt));
  const group = parked.containers.find((c) => c.id === win);
  check('the window was kept rather than ended', !!group?.closedAt, JSON.stringify(group));
  check('under the name of the host its first tab is on', group?.name === HOST,
    JSON.stringify(group?.name));
  check('and marked as a name clio chose, not one somebody typed', group?.named === false,
    JSON.stringify(group?.named));

  const final = new Client(info2, win);
  await final.connect();
  await final.await((m) => m.t === 'sessions');
  final.send({ t: 'close', id: sshTab.id });
  final.send({ t: 'close', id: workTab.id });
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
    /* already gone */
  }
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* leave it, it is in /tmp */
  }
}

main().catch((err) => {
  console.error('test harness error:', err);
  console.error(log.join(''));
  cleanup();
  process.exit(1);
});
