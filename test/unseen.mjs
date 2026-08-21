/*
 * A tab goes red when there is something in it to read.
 *
 * Which is a question about the screen, not about the bytes, and the difference
 * is a real morning: Claude Code checks for a new version every thirty minutes,
 * paints the answer into its footer while it waits for the network, and then
 * paints the footer back the way it was. Two frames of perfectly visible text,
 * a net change of nothing, and every idle agent on the desktop lighting up
 * twice an hour with nothing in it to look at.
 *
 * So this file is about both halves of that. First the screen model on its own
 * — fed the real 249 bytes off a real tab, and made to answer the question the
 * byte filter cannot. Then the daemon, with a tab painting the same thing at a
 * moment when nobody is watching it, which is the only moment any of this is
 * about.
 *
 *   node test/unseen.mjs
 */
import { mkdirSync, mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';

import { Screen } from '../src/daemon/screen.js';
import { drawsSomething } from '../src/daemon/output.js';

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

/* --------------------------------------------------- what an agent really wrote */

/*
 * Off tab c09b5f91d31b on 21 August, an idle Claude Code in ~/clio, 249 bytes
 * a second or so apart. The footer is written at column 190 of row 40, and then
 * written over with spaces and the token count it displaced.
 */
const CHECKING =
  '\x1b[?25l\x1b[H\r\x1b[189C\x1b[39B\x1b[38;2;153;153;153mcurrent: 2.1.238 · latest: 2.1.238' +
  '\x1b[225GChecking for update\x1b[39m\x1b[44;1H\x1b[42;3H\x1b[?25h';
const CHECKED =
  '\x1b[?25l\x1b[H\r\x1b[189C\x1b[39B                                  \x1b[225G       ' +
  '\x1b[38;2;153;153;153m283539 token\x1b[39m\x1b[44;1H\x1b[42;3H\x1b[?25h';

/* ------------------------------------------------------------- the screen alone */

function screenTests() {
  console.log('1. the screen, on its own');

  // The footer as it stands before the check: the token count where the wipe
  // will put it back, and nothing else on that row.
  const screen = new Screen({ cols: 236, rows: 44 });
  screen.write('\x1b[?25l\x1b[H\r\x1b[231C\x1b[39B\x1b[38;2;153;153;153m283539 token\x1b[39m\x1b[?25h');
  const seen = screen.digest();

  screen.write(CHECKING);
  const checking = screen.digest();
  screen.write(CHECKED);

  check('the byte filter says both frames drew something', drawsSomething(CHECKING) && drawsSomething(CHECKED));
  check('and it is right: the first frame changed the screen', checking !== seen);
  check('the pair of them put it back the way it was', screen.digest() === seen);
  check('and the screen is sure of itself throughout', screen.sure);

  // The spinner an agent draws while it works: a frame every half second, in
  // the same place, and one whole turn of it is no change at all. Fed in
  // kernel-sized bites so that a sequence split across two reads is part of
  // what is being tested.
  const frame = (glyph) =>
    `\x1b]0;${glyph} Working on the thing\x07\x1b[?25l\x1b[H\r\x1b[2C\x1b[38B` +
    `\x1b[38;2;153;153;153m${glyph} esc to interrupt\x1b[39m\x1b[44;1H\x1b[?25h`;

  const spinning = new Screen({ cols: 236, rows: 44 });
  spinning.write(`\x1b[H\x1b[2J${frame('◓')}`);
  const still = spinning.digest();
  let stream = '';
  for (let turn = 0; turn < 40; turn++) for (const glyph of '◐◑◒◓') stream += frame(glyph);
  for (let i = 0; i < stream.length; i += 4096) spinning.write(stream.slice(i, i + 4096));
  check('a hundred and sixty frames of a spinner are understood', spinning.sure);
  check('and land back on the screen they started from', spinning.digest() === still);

  // Something to actually read.
  const said = new Screen({ cols: 80, rows: 24 });
  said.write('\x1b[H\x1b[2J$ ');
  const prompt = said.digest();
  said.write('\x1b[12;1Hthe build failed\r\n');
  check('a line nobody has read is a changed screen', said.digest() !== prompt);

  // Cursor movement, colour, mouse reporting, a title: bytes with nothing in
  // them. The old filter knows this too; the point is that the new answer does
  // not disagree with it.
  const quiet = new Screen({ cols: 80, rows: 24 });
  quiet.write('\x1b[H\x1b[2Jhello');
  const settled = quiet.digest();
  quiet.write('\x1b(B\x0f\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b]0;a title\x07\x1b[38;5;9m\x1b[5;20H');
  check('mouse modes, a charset, a title and a cursor move change nothing', quiet.digest() === settled);
  check('which is what drawsSomething says as well', !drawsSomething('\x1b(B\x0f\x1b[?1000h\x1b]0;a title\x07'));

  // A sequence arriving in two pieces must not be read as two sequences.
  const split = new Screen({ cols: 80, rows: 24 });
  split.write('\x1b[H\x1b[2J\x1b[5;10Hxy');
  const whole = split.digest();
  const again = new Screen({ cols: 80, rows: 24 });
  again.write('\x1b[H\x1b[2J\x1b[5;1');
  again.write('0Hxy');
  check('an escape sequence split across two chunks is still one sequence', again.digest() === whole);

  // What this must never do: claim to know a screen it does not.
  const lost = new Screen({ cols: 80, rows: 24 });
  lost.write('\x1b[H\x1b[2Jsettled');
  check('a screen it has followed from blank is sure', lost.sure);
  lost.write('\x1b[4h'); // insert mode: the next text lands somewhere else
  check('a mode that moves text sideways is admitted, not ignored', !lost.sure);
  lost.write('\x1b[2J');
  check('and clearing the screen is how it becomes knowable again', lost.sure);

  // A pty inherited from the daemon before this one: the screen has something
  // on it that this process never saw.
  const handed = new Screen({ cols: 80, rows: 24, known: false });
  handed.write('\x1b[10;1Hstill here');
  check('an inherited screen never claims nothing happened', !handed.sure);

  // less, vim, fzf: the whole terminal borrowed and given back.
  const alt = new Screen({ cols: 80, rows: 24 });
  alt.write('\x1b[H\x1b[2Jat the prompt');
  const beneath = alt.digest();
  alt.write('\x1b[?1049h\x1b[H\x1b[2Jsome pager, filling the screen');
  check('the alternate screen is a different screen', alt.digest() !== beneath);
  alt.write('\x1b[?1049l');
  check('and leaving it puts back the one that was underneath', alt.digest() === beneath);
}

/* ------------------------------------------- the same bytes in a real terminal */

/*
 * Recordings that catch a model of somebody else's terminal being wrong.
 *
 * The screen these tabs are really drawn on is xterm.js, in the window — so the
 * way to find out whether ./screen.js models it or merely resembles it is to
 * put the same bytes through both and compare the screens row by row. What is
 * in here is the awkward half of a terminal: the wrap that happens one
 * character late, the scrolling region, lines and cells being inserted and
 * pushed sideways, the alternate screen, and every flavour of erase.
 */
const RECORDINGS = {
  'plain text and line feeds': 'hello\r\nsecond line\r\n\ttabbed\r\nlast',
  'the wrap that comes one character late': `\x1b[H\x1b[2J${'x'.repeat(80)}y\r\nafter`,
  'a carriage return after filling the line': `\x1b[H\x1b[2J${'x'.repeat(80)}\rover`,
  'wrapping off, then the last column overwritten': `\x1b[?7l${'abcdefgh'.repeat(12)}\x1b[?7h`,
  'backspace over what was written': 'abcdef\x08\x08\x08XYZ',
  'a scrolling region, filled past the bottom': `\x1b[5;10r\x1b[5;1H${Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\r\n')}`,
  'reverse index at the top of a region': '\x1b[3;8r\x1b[3;1Hbottom\x1bM\x1bMtop',
  'inserted and deleted lines': `\x1b[H\x1b[2J${'a\r\nb\r\nc\r\nd\r\ne'}\x1b[3;1H\x1b[2L\x1b[1;1H\x1b[1M`,
  'inserted, deleted and erased cells': '\x1b[H\x1b[2Jabcdefghij\x1b[1;4H\x1b[3@XY\x1b[1;2H\x1b[2P\x1b[1;6H\x1b[3X',
  'every erase there is': `\x1b[H\x1b[2J${'filler line\r\n'.repeat(9)}\x1b[4;5H\x1b[K\x1b[6;5H\x1b[1K\x1b[7;4H\x1b[2K\x1b[9;3H\x1b[1J\x1b[10;3H\x1b[0J`,
  'the alternate screen, and back': '\x1b[H\x1b[2Junderneath\x1b[?1049h\x1b[H\x1b[2Ja pager\x1b[?1049l',
  'cursor saved and restored': '\x1b[H\x1b[2J\x1b[5;5Hhere\x1b7\x1b[20;40Hthere\x1b8back',
  'a screenful scrolled off the top': Array.from({ length: 60 }, (_, i) => `row ${i}`).join('\r\n'),
  'the version check, over a footer': `\x1b[H\x1b[2J\x1b[?25l\x1b[H\r\x1b[231C\x1b[39B283539 token\x1b[?25h${CHECKING}${CHECKED}`,
  'colour, modes, titles and queries': '\x1b[H\x1b[2J\x1b[38;5;9mred\x1b[39m\x1b[?1000h\x1b]0;a name\x07\x1b[6n\x1b[>q\x1b[?2004h\x1b(B\x0f done',
};

async function terminalTests() {
  console.log('\n2. the same bytes, in the terminal the windows really use');
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    console.log('  – no playwright here, so the model is not held against a real terminal');
    return;
  }

  // The pinned build first, so a CI box uses the browser the project installed;
  // the desktop's own Chrome after it, because a machine that has never run
  // `playwright install` still has one and this is worth running there.
  let browser = null;
  for (const options of [{}, { channel: 'chrome' }]) {
    try {
      browser = await chromium.launch(options);
      break;
    } catch {
      /* try the next one */
    }
  }
  if (!browser) {
    console.log('  – no browser on this machine, so the model is not held against a real terminal');
    return;
  }

  const cols = 80;
  const rows = 24;
  const page = await browser.newPage();
  await page.setContent('<div id="screen"></div>');
  await page.addScriptTag({ path: join(ROOT, 'node_modules', '@xterm', 'xterm', 'lib', 'xterm.js') });

  for (const [what, recording] of Object.entries(RECORDINGS)) {
    const model = new Screen({ cols, rows });
    for (let i = 0; i < recording.length; i += 64) model.write(recording.slice(i, i + 64));

    const real = await page.evaluate(
      async ({ text, cols, rows }) => {
        const host = document.getElementById('screen');
        host.innerHTML = '';
        const term = new window.Terminal({ cols, rows, scrollback: 200 });
        term.open(host);
        await new Promise((resolve) => term.write(text, resolve));
        const buffer = term.buffer.active;
        const lines = [];
        for (let y = 0; y < rows; y++) {
          const line = buffer.getLine(buffer.viewportY + y);
          lines.push((line ? line.translateToString(false) : '').replace(/\s+$/, ''));
        }
        return lines;
      },
      { text: recording, cols, rows },
    );

    const ours = model.text();
    const off = [];
    for (let y = 0; y < rows; y++) if (ours[y] !== real[y]) off.push(y);
    check(
      what,
      off.length === 0,
      off.length ? `row ${off[0]}: ${JSON.stringify(ours[off[0]])} not ${JSON.stringify(real[off[0]])}` : '',
    );
  }

  await browser.close();
}

/* ---------------------------------------------------------------- the daemon */

const TMP = mkdtempSync(join(tmpdir(), 'clio-unseen-'));
const RUN = join(TMP, 'run');
const STATE = join(TMP, 'state');
const BIN = join(TMP, 'bin');
const WORK = join(TMP, 'work');
const HOME = join(TMP, 'home');
for (const dir of [RUN, STATE, BIN, WORK, HOME]) mkdirSync(dir, { recursive: true });

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
  CLIO_DEV: '1',
  CLIO_NO_UI_WATCH: '1',
};

const HANDSHAKE = join(RUN, 'clio', 'daemon.json');

let daemon = null;

function handshake() {
  return JSON.parse(readFileSync(HANDSHAKE, 'utf8'));
}

/** Wait for the daemon named in the handshake file to be somebody new. */
async function daemonAfter(oldPid, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const info = handshake();
      if (info.pid !== oldPid && alive(info.pid)) return info;
    } catch {
      /* mid-write, or not there yet */
    }
    await sleep(100);
  }
  return null;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

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

/** A stand-in for a window, which is also the only thing that ever sees red. */
class Client {
  constructor(info, container) {
    this.info = info;
    this.container = container;
    this.sessions = [];
    this.messages = [];
    /** Every tab that has ever been broadcast as having unseen output. */
    this.everRed = new Set();
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
        if (msg.t === 'sessions') {
          this.sessions = msg.sessions;
          for (const s of msg.sessions) if (s.unseenOutput) this.everRed.add(s.id);
        }
      });
    });
  }

  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }

  red(id) {
    return !!this.sessions.find((s) => s.id === id)?.unseenOutput;
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

async function daemonTests() {
  const fixture = join(ROOT, 'test', 'fixtures', 'footer');

  console.log(`\n3. a tab nobody is looking at    (sandbox at ${TMP})`);
  const info = await startDaemon();
  let client = new Client(info, '0ff1ce00');
  await client.connect();
  await client.await((m) => m.t === 'sessions');

  client.send({ t: 'create', cwd: WORK, cols: 80, rows: 24 });
  const painting = await client.await((m) => m.t === 'created');
  client.send({ t: 'create', cwd: WORK, cols: 80, rows: 24 });
  const other = await client.await((m) => m.t === 'created' && m.id !== painting?.id);
  if (!painting || !other) {
    check('two tabs', false, 'the daemon did not open them');
    return;
  }
  check('two tabs, one to paint in and one to look at instead', true);

  // Looked at, so that what it paints now is what somebody has seen. Run with
  // `exec` so there is no shell prompt underneath it: a prompt drawn after the
  // program ends is a changed screen, and a real one, which would drown out the
  // thing being measured.
  await sleep(800);
  client.send({ t: 'focus', id: painting.id });
  await sleep(200);
  client.send({ t: 'input', id: painting.id, data: `exec node ${fixture}\n` });

  // The opening paint lands while it is on screen; then the window looks away.
  await sleep(1200);
  client.send({ t: 'focus', id: other.id });
  await sleep(300);
  client.everRed.delete(painting.id);
  check('the tab being painted in is not red while it is being looked at', !client.red(painting.id));

  // The version check: visible text, twice, and a net change of nothing.
  client.send({ t: 'input', id: painting.id, data: 'v' });
  await sleep(3000);
  check('a repaint that puts the screen back does not turn the tab red', !client.red(painting.id));
  check('and it never went red in the meantime either', !client.everRed.has(painting.id));

  // Then something worth knowing about.
  client.send({ t: 'input', id: painting.id, data: 'n' });
  await sleep(2500);
  check('a line nobody has read does turn it red', client.red(painting.id));

  client.send({ t: 'focus', id: painting.id });
  await sleep(400);
  check('and looking at the tab puts the red out', !client.red(painting.id));

  /*
   * And again across a reload, which is the case that would otherwise be
   * missed. A successor daemon inherits the pty as an open descriptor and has
   * never seen a byte of what is on that screen — so unless it works the screen
   * out from the recording of the tab (see Session.replayScreen), the first
   * thing the program repaints after a reload reads as news and the row goes red
   * again. Which, on a desktop where reloading is how new code arrives, is every
   * time anybody touches clio.
   */
  console.log('\n4. and after a reload, on a screen this daemon never saw');
  // Past the scrollback flush, so the successor reads a recording that includes
  // everything above rather than depending on lucky timing.
  await sleep(3500);
  const before = info.pid;
  execFileSync(join(ROOT, 'bin', 'clio'), ['reload'], { env, stdio: 'ignore' });
  const next = await daemonAfter(before);
  check('a new daemon has the shells', !!next && next.pid !== before);
  if (!next) return;

  client.close();
  client = new Client(next, '0ff1ce00');
  await client.connect();
  await client.await((m) => m.t === 'sessions');
  // The window comes back and looks at the *other* tab, so nobody looks at this
  // one at all under the new daemon. Which is the real case: a reload happens
  // while somebody is working in one tab, and the twelve they are not in must
  // not light up afterwards for repainting themselves.
  client.send({ t: 'attach', id: other.id, cols: 80, rows: 24 });
  await client.await((m) => m.t === 'attached');
  client.send({ t: 'focus', id: other.id });
  await sleep(600);
  check('the tab nobody looked at is not red after the reload', !client.red(painting.id));
  client.everRed.delete(painting.id);

  client.send({ t: 'input', id: painting.id, data: 'v' });
  await sleep(3000);
  check('the repaint is still not news to a daemon that has just started',
    !client.red(painting.id) && !client.everRed.has(painting.id));

  client.send({ t: 'input', id: painting.id, data: 'n' });
  await sleep(2500);
  check('and a line nobody has read still is', client.red(painting.id));

  /*
   * The last second before a reload, which is the seam this could fall through.
   * A tab is judged a beat after it stops drawing (see UNSEEN_SETTLE_MS), and a
   * reload inside that beat takes the daemon that was going to do the judging
   * away with it — so the flag has to be settled on the way out, or the
   * successor inherits a screen it takes to have been seen and the line is lost.
   */
  console.log('\n5. output that arrives just as the daemon is standing down');
  client.send({ t: 'focus', id: painting.id });
  await sleep(400);
  client.send({ t: 'focus', id: other.id });
  await sleep(3500);
  client.everRed.delete(painting.id);
  check('and the tab starts this one clean', !client.red(painting.id));

  const beforeAgain = next.pid;
  client.send({ t: 'input', id: painting.id, data: 'n' });
  execFileSync(join(ROOT, 'bin', 'clio'), ['reload'], { env, stdio: 'ignore' });
  const last = await daemonAfter(beforeAgain);
  check('the shells came across again', !!last && last.pid !== beforeAgain);
  if (!last) return;

  client.close();
  client = new Client(last, '0ff1ce00');
  await client.connect();
  await client.await((m) => m.t === 'sessions');
  await sleep(1500);
  check('the line still counts as unread on the other side of the reload',
    client.red(painting.id));

  client.close();
}

/* -------------------------------------------------------------------- report */

function report() {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) console.log(`\n---- daemon log ----\n${log.join('')}`);
  stop();
  process.exit(failed ? 1 : 0);
}

function stop() {
  // The daemon this test started, and — after a reload — the one it handed the
  // shells to, which is a child of that rather than of this process.
  try {
    const running = handshake().pid;
    if (running !== daemon?.pid) process.kill(running, 'SIGKILL');
  } catch {
    /* no handshake, or nothing behind it */
  }
  if (!daemon) return;
  try {
    daemon.kill('SIGKILL');
  } catch {
    /* already gone */
  }
  daemon = null;
}
process.on('exit', stop);

async function main() {
  screenTests();
  await terminalTests();
  await daemonTests();
  report();
}

main().catch((err) => {
  console.error(err);
  failed++;
  report();
});
