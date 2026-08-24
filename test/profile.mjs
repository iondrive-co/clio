/*
 * The login profile — the thing every restore has to get through before it can
 * put anything back, and the thing every test here had quietly arranged not to
 * have.
 *
 * A sandbox home has no .bashrc in it. That is what made every other test in
 * this directory pass while the restore on a real desktop was broken: with no
 * profile, a shell is at its prompt the moment it exists, and the two promises
 * clio makes about a restore are never actually tested.
 *
 *   1. Nothing is typed into a shell that is still running its profile. A
 *      resume command typed at a passphrase prompt is offered to an ssh key as
 *      its password — on 24 August `bash scripts/ainun-dashboard-agent.sh` was.
 *   2. One shell goes first and the rest wait behind it, so that the profile's
 *      once-per-machine work — a key into an agent — is done once and asked
 *      about once. Sixty-two tabs asking for the same passphrase at 21:22:42 is
 *      what not doing that looks like.
 *
 * So the sandbox here has a profile, and in it the one thing that makes this
 * hard: something that asks a question and waits. See
 * test/fixtures/ask-passphrase.sh, which is keychain's shape and nothing more.
 *
 * Section 1 needs no daemon at all — it is the kernel fact underneath both
 * promises, and it is where the bug was.
 *
 *   node test/profile.mjs
 */
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

/* -------------------------------------------- 1. what /proc says about a profile */

/*
 * A shell running its profile, seen from outside.
 *
 * The kernel fact: a shell puts a job in a process group of its own only once
 * job control is on, and bash turns job control on *after* its startup files.
 * So tpgid — which is how you find the job that has the terminal, and how clio
 * found it everywhere until this test was written — cannot see a profile at all.
 * Whatever a .bashrc is doing, the shell looks exactly like a shell at its own
 * prompt.
 *
 * Both halves are checked, because the half that reports nothing is not a bug
 * in foregroundCommand: "what is running in this tab" is a different question
 * from "may this shell be typed at", and only the second one has to see this.
 */
async function readsAProfile() {
  console.log('1. a shell in its profile, from /proc');

  const home = mkdtempSync(join(tmpdir(), 'clio-profile-proc-'));
  // Three shapes, in the order a profile has them: a plain command, a command
  // substitution (keychain's shape), and then the prompt.
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

  // The profile is over once the shell has been left alone for a while; the
  // last half second of the window is the shell at its prompt and nothing else.
  const during = seen.filter((s) => s.at < 1500);
  const after = seen.filter((s) => s.at > 2100);

  check(
    'tpgid alone sees nothing at all while the profile runs',
    during.every((s) => !s.fg),
    `${during.filter((s) => s.fg).length} of ${during.length} samples saw a job`,
  );
  // Every sample but the first: the instant of the spawn itself, before bash has
  // forked the first line of its profile, is the one moment /proc cannot tell a
  // shell that has not started from a shell that has finished. Session's
  // settlePending looks twice for exactly that reason.
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

/* ---------------------------------------------------------------- a sandbox */

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
  // Nothing here asks for a window, and nothing here may put one on somebody's
  // desktop by accident either.
  DISPLAY: undefined,
  WAYLAND_DISPLAY: undefined,
  HOME,
  // The profile below is a .bashrc, so the shell has to be the one that reads
  // one. Whatever the machine running this test uses is not the subject.
  SHELL: '/bin/bash',
  XDG_RUNTIME_DIR: RUN,
  XDG_STATE_HOME: STATE,
  // Says "sandbox" in the window title, and keeps this away from the real one.
  CLIO_DEV: '1',
  CLIO_NO_UI_WATCH: '1',
};

const HANDSHAKE = join(RUN, 'clio', 'daemon.json');

let daemon = null;

/** A daemon of this test's own, and proof that it is listening. */
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

  async newTab() {
    const before = new Set(this.messages.filter((m) => m.t === 'created').map((m) => m.id));
    this.send({ t: 'create', cwd: WORK, cols: 80, rows: 24 });
    const tab = await this.await((m) => m.t === 'created' && !before.has(m.id));
    return tab?.id || null;
  }

  /** What this tab has said since a mark in its output. */
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

/* ------------------------------------------------------------------ the test */

async function main() {
  await readsAProfile();

  copyFileSync(join(ROOT, 'test', 'fixtures', 'loop.sh'), SCRIPT);
  chmodSync(SCRIPT, 0o755);
  copyFileSync(join(ROOT, 'test', 'fixtures', 'ask-passphrase.sh'), ASK);
  chmodSync(ASK, 0o755);

  /*
   * The profile. Keychain's line, more or less exactly: a command substitution
   * whose output is eval'd, which asks on the terminal the first time it is run
   * on a machine and says nothing every time after that.
   */
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
  check('a tab to run the script in', !!scriptTab);
  check('and one behind it', !!plainTab);
  if (!scriptTab || !plainTab) return report();

  // The first shell of the machine asks, and something has to answer it or
  // nothing else in this test can happen. This is a person at the desk.
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
  await sleep(3000); // the proc poll, so the tab is on record as holding it
  check('and the tab is on record as holding it', client.tab(scriptTab)?.ext?.kind === 'script',
    JSON.stringify(client.tab(scriptTab)?.ext));

  /*
   * Now the machine is put back the way it is on the morning after a reboot:
   * the daemon gone, and the key no longer in any agent. That second part is
   * what makes this the interesting restore rather than the easy one — every
   * profile that runs from here has something to ask.
   */
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
  // From the seam, not from the end of the replay: a restore is quicker than a
  // websocket, so the shell has usually been started — and asked its question —
  // before this window ever attached. What happened "since the restore" is
  // everything from the line clio drew to say it was restoring.
  const mark = Math.max(0, replayed.lastIndexOf('new shell'));
  check('the seam says the script is being restarted', replayed.includes('restarting'),
    JSON.stringify(replayed.slice(-200)));

  console.log('\n4. the restored shell is asked for the passphrase, and is left alone until it is answered');
  const askedAgain = await back.said(scriptTab, 'Enter passphrase', 10000, mark);
  check('the lead shell asks', askedAgain, JSON.stringify(back.since(scriptTab, mark).slice(-200)));

  // The heart of it. While that question is on the screen the tab must be
  // exactly as clio left it: the seam, the question, and nothing typed.
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

  // And the tab behind it has not been given a shell, because what the lead is
  // buying — one answer, for every profile on the machine — has not been bought.
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

  // The whole argument for the lead, in one assertion: one question for the
  // machine, not one per tab.
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

  /*
   * And the other way it can go: a profile that never comes free at all.
   *
   * The cap is the backstop for that, and what happens when it runs out is the
   * whole of the difference between one stuck tab and a screenful of them. The
   * tabs behind this one are not released together — what the lead was buying
   * has not been bought — so they follow one at a time, each one its own chance
   * to answer whatever is being asked.
   *
   * The profile here holds the terminal without asking anything, which is how
   * this can be seen in forty seconds instead of the two and a half minutes a
   * standing question is given. See QUESTION_HOLD_MS.
   */
  console.log('\n6. a profile that never comes free, and the tabs behind it');
  back.close();
  daemon.kill('SIGKILL');
  writeFileSync(join(HOME, '.bashrc'), ['sleep 40', 'PS1="sandbox$ "', ''].join('\n'));
  await sleep(700);

  const info3 = await startDaemon();
  const held = new Client(info3, win);
  await held.connect();
  await held.await((m) => m.t === 'sessions');
  const lead = held.tab(scriptTab)?.order <= held.tab(plainTab)?.order ? scriptTab : plainTab;
  const behind = lead === scriptTab ? plainTab : scriptTab;

  await sleep(20000);
  check(
    'twenty seconds in, the lead still has the terminal and the tab behind it has no shell',
    held.tab(lead)?.status === 'live' && held.tab(behind)?.status === 'restorable',
    `lead ${held.tab(lead)?.status}, behind ${held.tab(behind)?.status}`,
  );

  // The cap, and the bargain it falls back to: the command is named in the tab
  // rather than typed into whatever has the terminal.
  const gaveUp = await (async () => {
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      if (held.tab(behind)?.status === 'live') return true;
      await sleep(250);
    }
    return false;
  })();
  check('the tab behind it gets its shell once the cap runs out', gaveUp, `${held.tab(behind)?.status}`);
  if (lead === scriptTab) {
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
    /* already gone */
  }
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* leave it */
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
