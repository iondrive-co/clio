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

/**
 * Which conversation a tab is holding, read off the disk.
 *
 * A window is told that a tab has an agent in it and never which conversation
 * — the state is the adapter's and stays in the daemon — so the state file is
 * where it can be seen, which is also where it has to be right for a restore.
 */
function heldBy(id) {
  return savedState().sessions.find((s) => s.id === id)?.ext?.state?.sessionId ?? null;
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
  check('and the state file says which shape that is in', saved.version === 6, `v${saved.version}`);

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

  /*
   * And it came back quiet. A tab rebuilt from disk is holding an agent that
   * stopped before this daemon existed — after a reboot that is every agent tab
   * on the machine — so a flash there would light the whole row up on the way
   * back, about nothing that has just happened. See section 9 for the flash
   * itself, and observeAttention in src/extensions for why it is an edge.
   */
  check(
    'and the restored tab is not flashing about having stopped',
    back.tab(agentTab.id)?.waiting === false,
    JSON.stringify(back.tab(agentTab.id)?.waiting),
  );
  /*
   * Nor red, which is the same argument about the other flag. Everything these
   * tabs have drawn since the daemon came back — a login profile, the seam, the
   * resume command being echoed, an agent painting itself — is clio putting
   * them back, and none of it is something to go and read. The tab next door is
   * the one that proves it: nobody has attached to that one, so it is a tab
   * nobody is looking at, which is the only kind that can go red at all. See
   * ARRIVING_QUIET_MS in src/daemon/session.js.
   */
  // Waited for, because the tab next door is rebuilt behind the lead and a tab
  // with no shell in it yet has drawn nothing to be judged on. Then a beat for
  // the daemon to make up its mind about what it drew; see UNSEEN_SETTLE_MS.
  for (let i = 0; i < 100 && !back.tab(plainTab.id)?.pid; i++) await sleep(200);
  await sleep(2500);
  check(
    'and neither tab came back red',
    back.tab(agentTab.id)?.unseenOutput === false && back.tab(plainTab.id)?.unseenOutput === false,
    JSON.stringify([back.tab(agentTab.id)?.unseenOutput, back.tab(plainTab.id)?.unseenOutput]),
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

  // ---- the other morning this was written for ----------------------------
  console.log('\n7. a conversation that was never in a terminal is left where it is');
  /*
   * ~/.claude/projects is not the terminal's. The desktop app writes its
   * conversations into the same directory, and so does every -p run and every
   * SDK script, because the directory is named after the working directory and
   * that is the one thing they all share. The adapter took the newest file in
   * it, so on 15 August a tab in ~/proteus came back running `claude --resume
   * 646626df` — a conversation held in the desktop app, which had never been in
   * that tab and could not be continued from one.
   */
  const seven = await agentIn(last);
  check('a tab with a conversation of its own', !!seven.conversation, seven.detail);

  writeTranscript(newId(), 'claude-desktop');
  await sleep(RECAPTURE_MS);
  check(
    'the desktop app writing next door does not move the tab',
    heldBy(seven.id) === seven.conversation,
    `${heldBy(seven.id)} vs ${seven.conversation}`,
  );

  console.log('\n8. two tabs never end up on one conversation');
  /*
   * The same restore put `claude --resume f7147610` into two tabs in ~/ops, and
   * a conversation resumed twice is one of them typing over the other. Every
   * tab's claim is meant to be off the table for the rest, and it was — but the
   * table was laid once at the top of a poll and not touched again, so two tabs
   * that both changed their minds in the same pass could change them to the
   * same thing.
   *
   * Which is this: a third conversation, newer than either tab's own, that both
   * of them can see and neither of them wrote — and two tabs started together,
   * so that they are asked about it in the same pass, which is the only moment
   * the two of them were ever able to collide.
   */
  const one = await newTab(last);
  const two = await newTab(last);
  check('two more tabs', !!one && !!two);
  if (!one || !two) return report();

  await sleep(800);
  last.send({ t: 'input', id: one, data: 'claude\n' });
  last.send({ t: 'input', id: two, data: 'claude\n' });
  await sleep(6000);

  const oneConv = heldBy(one);
  const twoConv = heldBy(two);
  check('each on a conversation of its own', !!oneConv && !!twoConv, `${oneConv} vs ${twoConv}`);
  check('and not on each other\'s', oneConv !== twoConv, `${oneConv} vs ${twoConv}`);

  /*
   * And the morning after that one. A tab holding a conversation is not looking
   * for another, however new: every tab in a repository writes into the same
   * directory, so the newest file in it is the tab next door finishing a turn.
   * Taking it used to be deliberate — starting a fresh conversation in a tab
   * that had one is a change of subject rather than a second tab — and in a
   * directory with one tab in it that is exactly right. In a directory with
   * four, it recorded each tab as holding its neighbour's conversation, nothing
   * looked wrong until the crash, and then the restore typed what had been
   * written down into all four of them.
   *
   * Every tab holding a conversation is checked and not just the two just
   * opened, because the one that loses is whichever is asked first — the tab
   * that has been there longest, whose claim was taken while it sat idle.
   */
  const held = new Map([one, two, seven.id].map((id) => [id, heldBy(id)]));
  writeTranscript(newId(), 'cli');
  await sleep(RECAPTURE_MS);
  const moved = [...held].filter(([id, was]) => heldBy(id) !== was);
  check(
    'and a conversation loose in the directory moves none of them',
    moved.length === 0,
    moved.map(([id, was]) => `${id}: ${was} → ${heldBy(id)}`).join(', '),
  );

  console.log('\n9. a tab whose agent has stopped says so — unless you are looking at it');
  /*
   * An agent that has finished a turn, or that is holding a question up, stops
   * writing the spinner into its terminal title. Nothing else about the tab
   * changes: the process is the same process, the transcript looks the same at
   * the end of a turn as it does with a permission prompt on screen. So the
   * title is what this reads, and what is tested here is the whole chain of it —
   * the stand-in stops, the adapter notices, and a window is told without
   * having asked anything.
   */
  const flash = await newTab(last);
  check('a tab to watch stop', !!flash);
  if (!flash) return report();

  // And look at something else. Opening a tab is looking at it, so without this
  // the tab under test is the one on screen for the whole of the section — and
  // the tab on screen is the one tab that is never flashed at.
  last.send({ t: 'focus', id: one });
  await sleep(800);
  last.send({ t: 'input', id: flash, data: 'claude\n' });
  await sleep(5000);
  check(
    'an agent that has not worked yet is not news',
    last.tab(flash)?.waiting === false,
    JSON.stringify(last.tab(flash)?.waiting),
  );

  // A turn: the stand-in spins for a couple of seconds and then stops. That
  // edge is the whole feature.
  last.send({ t: 'input', id: flash, data: 'a question\n' });
  check(
    'the tab flashes once its agent stops',
    await until(() => last.tab(flash)?.waiting === true),
    JSON.stringify(last.tab(flash)),
  );

  last.send({ t: 'focus', id: flash });
  check(
    'and stops the moment somebody looks at it',
    await until(() => last.tab(flash)?.waiting === false, 4000),
    JSON.stringify(last.tab(flash)?.waiting),
  );

  // Nor does a tab somebody is looking at ever start. The terminal is on screen
  // saying the same thing in full; a flashing label is for the tabs you are not
  // in front of.
  last.send({ t: 'input', id: flash, data: 'another question\n' });
  await sleep(9000);
  check(
    'a tab being watched does not flash at all',
    last.tab(flash)?.waiting === false,
    JSON.stringify(last.tab(flash)?.waiting),
  );

  // Look away, and the next time it stops it is news again.
  last.send({ t: 'focus', id: one });
  last.send({ t: 'input', id: flash, data: 'once more\n' });
  check(
    'and once nobody is looking, the next stop flashes again',
    await until(() => last.tab(flash)?.waiting === true),
    JSON.stringify(last.tab(flash)),
  );

  console.log('\n10. a tab that changes conversation without changing process');
  /*
   * The other side of test 8, and the reason a tab holding a conversation
   * cannot simply be left alone forever: `/clear` starts a new conversation in
   * the same process. Nothing about the tab changes — same pid, same command,
   * same directory — and the transcript it was on stops being the one it is
   * showing.
   *
   * Which cannot be seen from the directory, because the newest file in it is
   * whatever any tab wrote last, so this is the case the child processes are
   * for: the id is not in the agent's own environment, but it is in the
   * environment of everything the agent has started since, and the stand-in
   * keeps one of those the way the real one keeps its MCP servers. To make sure
   * that is what is being read and not the mtimes, there is a conversation
   * loose in the directory that is newer than either.
   */
  const cleared = await agentIn(last);
  check('a tab on a conversation to clear', !!cleared.conversation, cleared.detail);

  const quiet = (last.output.get(cleared.id) || '').length;
  last.send({ t: 'input', id: cleared.id, data: '/clear\n' });
  await sleep(2000);
  writeTranscript(newId(), 'cli');
  const said = (last.output.get(cleared.id) || '').slice(quiet);
  const after = /STARTED ([0-9a-f-]{36})/.exec(said)?.[1] || null;
  check('and a new one started in it', !!after && after !== cleared.conversation, JSON.stringify(said.slice(-200)));

  await sleep(RECAPTURE_MS);
  check(
    'the tab is recorded as holding the new conversation',
    heldBy(cleared.id) === after,
    `${heldBy(cleared.id)} vs ${after}`,
  );

  last.send({ t: 'close', id: cleared.id });
  last.send({ t: 'close', id: flash });
  last.send({ t: 'close', id: seven.id });
  last.send({ t: 'close', id: one });
  last.send({ t: 'close', id: two });
  await sleep(600);
  last.close();

  report();
}

/*
 * Long enough for an adapter to be asked to look again — CAPTURE_INTERVAL_MS in
 * src/extensions, plus a proc poll to carry the question, plus room to spare.
 */
const RECAPTURE_MS = 12000;

/**
 * Wait for something the daemon says to become true.
 *
 * The tab flash arrives on the proc poll and is broadcast when it changes, so
 * the wait is for a session field to turn over rather than for a message of its
 * own — and a fixed sleep long enough to be reliable is long enough to be worth
 * not spending on every run.
 */
async function until(pred, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(150);
  }
  return false;
}

const newId = () =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });

/**
 * A conversation in the sandbox's project directory that no tab is holding —
 * the desktop app's, or a script's, or one from a terminal that has since gone.
 *
 * Written with the same shape a real one has: settings first, then entries, and
 * `entrypoint` on the entries. Which entrypoint is the whole point of it.
 */
function writeTranscript(id, entrypoint) {
  const dir = join(CLAUDE_CONFIG, 'projects', WORK.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.jsonl`),
    [
      JSON.stringify({ type: 'mode', mode: 'normal', sessionId: id }),
      JSON.stringify({ type: 'user', sessionId: id, entrypoint, cwd: WORK, timestamp: new Date().toISOString() }),
      '',
    ].join('\n'),
  );
  return id;
}

/** Another tab in the sandbox's working directory, or null. */
async function newTab(client) {
  // Every `created` this client has ever been sent is still in its log, so the
  // new one is the one that is not among them.
  const before = new Set(client.messages.filter((m) => m.t === 'created').map((m) => m.id));
  client.send({ t: 'create', cwd: WORK, cols: 80, rows: 24 });
  const tab = await client.await((m) => m.t === 'created' && !before.has(m.id));
  return tab?.id || null;
}

/** A new tab with an agent running in it, and the conversation it opened. */
async function agentIn(client) {
  const id = await newTab(client);
  if (!id) return { id: null, conversation: null, detail: 'no tab' };

  await sleep(800);
  const quiet = (client.output.get(id) || '').length;
  client.send({ t: 'input', id, data: 'claude\n' });
  await sleep(6000);

  const said = (client.output.get(id) || '').slice(quiet);
  const started = /STARTED ([0-9a-f-]{36})/.exec(said);
  return { id, conversation: started?.[1] || null, detail: JSON.stringify(said.slice(-200)) };
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
