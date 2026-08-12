/*
 * The conversation clio starts for you. (The other thing it starts is an ssh
 * session; that is test/ssh.mjs.)
 *
 * A tab with an agent in it is a tab with a conversation in it, and a reboot
 * must not be the end of that conversation. This drives the whole path: notice
 * the agent while it runs, write down which conversation it is, kill the daemon
 * outright, and check that the tab comes back with the same conversation open —
 * while the tab next to it, which was running an ordinary command, comes back
 * with the command named and deliberately not re-run.
 *
 * Runs a clio of its own, on its own state, with a stand-in for claude on its
 * PATH: nothing here touches the daemon anybody is working in, and the machine
 * does not need Claude Code installed.
 *
 *   node test/agents.mjs
 */
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

/* ---------------------------------------------------------------- a sandbox */

const TMP = mkdtempSync(join(tmpdir(), 'clio-agents-'));
const RUN = join(TMP, 'run');
const STATE = join(TMP, 'state');
const BIN = join(TMP, 'bin');
const CLAUDE_CONFIG = join(TMP, 'claude-config');
const WORK = join(TMP, 'work');
const HOME = join(TMP, 'home');
for (const dir of [RUN, STATE, BIN, CLAUDE_CONFIG, WORK, HOME]) mkdirSync(dir, { recursive: true });

// The stand-in goes on PATH ahead of anything real, and the daemon is the only
// thing that will ever see this PATH.
//
// A home of its own as well, and not for tidiness: the shells clio opens read
// the profile in it, and a real profile puts ~/.local/bin at the front of PATH
// — which on a machine with Claude Code installed means the test quietly drives
// the actual agent, in a real conversation, instead of the stand-in.
const env = {
  ...process.env,
  // Nothing here asks for a window, and nothing here may put one on somebody's
  // desktop by accident either.
  DISPLAY: undefined,
  WAYLAND_DISPLAY: undefined,
  HOME,
  PATH: `${BIN}:${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
  XDG_RUNTIME_DIR: RUN,
  XDG_STATE_HOME: STATE,
  CLAUDE_CONFIG_DIR: CLAUDE_CONFIG,
  // Says "sandbox" in the window title, and keeps this away from the real one.
  CLIO_DEV: '1',
  CLIO_NO_UI_WATCH: '1',
};

const HANDSHAKE = join(RUN, 'clio', 'daemon.json');

let daemon = null;

/**
 * A daemon of this test's own, and proof that it is listening.
 *
 * A killed daemon leaves its handshake file behind, so the file existing is not
 * the signal — the pid in it being this process's child is. Connecting on the
 * strength of a stale one is how a restart test ends up talking to a port
 * nothing is on any more.
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

  close() {
    this.ws.close();
  }
}

function savedState() {
  return JSON.parse(readFileSync(join(STATE, 'clio', 'state.json'), 'utf8'));
}

/* ------------------------------------------------------------------- the test */

async function main() {
  // The stand-in, on the sandbox's PATH and nowhere else.
  copyFileSync(join(ROOT, 'test', 'fixtures', 'claude'), join(BIN, 'claude'));
  chmodSync(join(BIN, 'claude'), 0o755);

  console.log(`sandbox at ${TMP}\n`);
  const info = await startDaemon();
  console.log(`1. an agent in a tab, and an ordinary command next to it`);

  const win = 'a'.repeat(8);
  const client = new Client(info, win);
  await client.connect();
  await client.await((m) => m.t === 'sessions');

  client.send({ t: 'create', cwd: WORK, cols: 80, rows: 24 });
  const agentTab = await client.await((m) => m.t === 'created');
  check('a tab to run the agent in', !!agentTab);
  if (!agentTab) return report();

  client.send({ t: 'create', cwd: WORK, cols: 80, rows: 24 });
  const plainTab = await client.await((m) => m.t === 'created' && m.id !== agentTab.id);
  check('and one for an ordinary command', !!plainTab);

  await sleep(800);
  client.send({ t: 'input', id: agentTab.id, data: 'claude\n' });
  client.send({ t: 'input', id: plainTab.id, data: 'sleep 900\n' });

  // Long enough for the agent to write its first line and for the proc poll to
  // come round and notice what is running.
  await sleep(5000);

  const started = /STARTED ([0-9a-f-]{36})/.exec(client.output.get(agentTab.id) || '');
  check('the agent started and opened a conversation', !!started,
    JSON.stringify((client.output.get(agentTab.id) || '').slice(-200)));
  const conversation = started?.[1];

  console.log('\n2. the daemon writes down what it found, before it needs it');
  const seen = client.tab(agentTab.id);
  check('the tab is marked as holding an agent', seen?.ext?.kind === 'claude', JSON.stringify(seen?.ext));
  check('the ordinary tab is not', client.tab(plainTab.id)?.ext === null);

  const saved = savedState();
  const savedAgent = saved.sessions.find((s) => s.id === agentTab.id)?.ext;
  check('the agent record is on disk', !!savedAgent, JSON.stringify(saved.sessions.map((s) => s.ext)));
  check('under the adapter that found it', savedAgent?.kind === 'claude');
  check(
    'naming the conversation that was open',
    savedAgent?.state?.sessionId === conversation,
    `${savedAgent?.state?.sessionId} vs ${conversation}`,
  );
  check('and the state file says which shape that is in', saved.version === 5, `v${saved.version}`);

  // ---- the part that matters ---------------------------------------------
  console.log('\n3. the daemon is killed outright, and started again');
  client.close();
  daemon.kill('SIGKILL');
  await sleep(700);

  const info2 = await startDaemon();
  check('the daemon came back', !!info2.pid && info2.pid !== info.pid);

  const back = new Client(info2, win);
  await back.connect();
  await back.await((m) => m.t === 'sessions');

  back.send({ t: 'attach', id: agentTab.id, cols: 80, rows: 24 });
  const replayed = (await back.await((m) => m.t === 'attached' && m.id === agentTab.id))?.scrollback || '';

  check(
    'the seam says the conversation is being resumed',
    replayed.includes('resuming the Claude Code conversation'),
    JSON.stringify(replayed.slice(-300)),
  );
  // The agent itself has to answer, or all of the above is clio talking to
  // itself: this line comes out of the process, and names the conversation it
  // was given.
  const resumed = await (async () => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if ((back.output.get(agentTab.id) || '').includes(`RESUMED ${conversation}`)) return true;
      await sleep(200);
    }
    return false;
  })();
  const since = back.output.get(agentTab.id) || '';
  check('and the agent came back on that same conversation', resumed, JSON.stringify(since.slice(-300)));

  // Typed into the shell rather than exec'd around it, so the terminal echoes
  // it: what happened here is legible to whoever opens the tab, and repeatable
  // from its history.
  check(
    'the resume command was typed into the new shell, in view',
    since.includes(`claude --resume ${conversation}`),
    JSON.stringify(since.slice(-300)),
  );

  console.log('\n4. the tab next door is left alone');
  back.send({ t: 'attach', id: plainTab.id, cols: 80, rows: 24 });
  const plainReplay = (await back.await((m) => m.t === 'attached' && m.id === plainTab.id))?.scrollback || '';
  check(
    'an ordinary command is named, not re-run',
    plainReplay.includes('sleep 900') && plainReplay.includes('was not restarted'),
    JSON.stringify(plainReplay.slice(-200)),
  );

  console.log('\n5. quitting the agent is quitting the agent');
  // A record that outlived the process would be a tab that resurrects a
  // conversation somebody deliberately closed.
  await sleep(2500);
  back.send({ t: 'input', id: agentTab.id, data: '' }); // Ctrl-C
  await sleep(5000);
  const afterQuit = back.tab(agentTab.id);
  check('the tab stops claiming an agent once it has gone', afterQuit?.ext === null,
    JSON.stringify(afterQuit?.ext));
  check(
    'and the record is off the disk too',
    !savedState().sessions.find((s) => s.id === agentTab.id)?.ext,
    JSON.stringify(savedState().sessions.map((s) => s.ext)),
  );

  // ---- the morning this was written for ----------------------------------
  console.log('\n6. a conversation whose record did not survive is still named');
  /*
   * The failure this is really about. A daemon that has been up since before
   * the agents extension existed has never written a record for anything, so a
   * crash gives every tab back with `claude … was running here and was not
   * restarted` — true, and no use at all, because the one thing needed to get
   * the conversation back is its id.
   *
   * Simulated by taking the record off the disk while the daemon is down,
   * which is exactly the state such a daemon leaves behind: a tab that knows
   * the command it was running and nothing else.
   */
  back.send({ t: 'input', id: agentTab.id, data: 'claude\n' });
  await sleep(5000);
  const second = /STARTED ([0-9a-f-]{36})/.exec(back.output.get(agentTab.id) || '');
  const conversation2 = second?.[1] || conversation;
  check('a second conversation to lose', !!second, JSON.stringify(conversation2));

  back.close();
  daemon.kill('SIGKILL');
  await sleep(700);

  const stripped = savedState();
  for (const tab of stripped.sessions) delete tab.ext;
  writeFileSync(join(STATE, 'clio', 'state.json'), JSON.stringify(stripped, null, 2));
  check('the record is off the disk, as it would never have been on it',
    !savedState().sessions.some((s) => s.ext));

  const info3 = await startDaemon();
  check('the daemon came back a second time', !!info3.pid);

  const last = new Client(info3, win);
  await last.connect();
  await last.await((m) => m.t === 'sessions');
  last.send({ t: 'attach', id: agentTab.id, cols: 80, rows: 24 });
  const seam = (await last.await((m) => m.t === 'attached' && m.id === agentTab.id))?.scrollback || '';

  check(
    'the tab says the command was not restarted, as before',
    seam.includes('was not restarted'),
    JSON.stringify(seam.slice(-300)),
  );
  check(
    'but now it also says how to pick the conversation up',
    seam.includes('to pick that up again:') && seam.includes(`claude --resume ${conversation2}`),
    JSON.stringify(seam.slice(-300)),
  );
  // Printed, not run: without a record this is the newest transcript in the
  // directory, which is a guess, and a guess must not be executed at anybody.
  await sleep(3000);
  check(
    'and did not run it',
    !last.tab(agentTab.id)?.command,
    JSON.stringify(last.tab(agentTab.id)?.command),
  );

  last.send({ t: 'close', id: agentTab.id });
  last.send({ t: 'close', id: plainTab.id });
  await sleep(600);
  last.close();

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
