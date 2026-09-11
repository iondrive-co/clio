import { mkdirSync, mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';

import { Screen, isNews, lastScreenSwap, MOVING } from '../src/daemon/screen.js';
import { drawsSomething } from '../src/daemon/output.js';
import { Session } from '../src/daemon/session.js';

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

const CHECKING =
  '\x1b[?25l\x1b[H\r\x1b[189C\x1b[39B\x1b[38;2;153;153;153mcurrent: 2.1.238 · latest: 2.1.238' +
  '\x1b[225GChecking for update\x1b[39m\x1b[44;1H\x1b[42;3H\x1b[?25h';
const CHECKED =
  '\x1b[?25l\x1b[H\r\x1b[189C\x1b[39B                                  \x1b[225G       ' +
  '\x1b[38;2;153;153;153m283539 token\x1b[39m\x1b[44;1H\x1b[42;3H\x1b[?25h';

function screenTests() {
  console.log('1. the screen, on its own');

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

  const said = new Screen({ cols: 80, rows: 24 });
  said.write('\x1b[H\x1b[2J$ ');
  const prompt = said.digest();
  said.write('\x1b[12;1Hthe build failed\r\n');
  check('a line nobody has read is a changed screen', said.digest() !== prompt);

  const quiet = new Screen({ cols: 80, rows: 24 });
  quiet.write('\x1b[H\x1b[2Jhello');
  const settled = quiet.digest();
  quiet.write('\x1b(B\x0f\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b]0;a title\x07\x1b[38;5;9m\x1b[5;20H');
  check('mouse modes, a charset, a title and a cursor move change nothing', quiet.digest() === settled);
  check('which is what drawsSomething says as well', !drawsSomething('\x1b(B\x0f\x1b[?1000h\x1b]0;a title\x07'));

  const split = new Screen({ cols: 80, rows: 24 });
  split.write('\x1b[H\x1b[2J\x1b[5;10Hxy');
  const whole = split.digest();
  const again = new Screen({ cols: 80, rows: 24 });
  again.write('\x1b[H\x1b[2J\x1b[5;1');
  again.write('0Hxy');
  check('an escape sequence split across two chunks is still one sequence', again.digest() === whole);

  const lost = new Screen({ cols: 80, rows: 24 });
  lost.write('\x1b[H\x1b[2Jsettled');
  check('a screen it has followed from blank is sure', lost.sure);
  lost.write('\x1b[4h');
  check('a mode that moves text sideways is admitted, not ignored', !lost.sure);
  lost.write('\x1b[2J');
  check('and clearing the screen is how it becomes knowable again', lost.sure);

  const handed = new Screen({ cols: 80, rows: 24, known: false });
  handed.write('\x1b[10;1Hstill here');
  check('an inherited screen never claims nothing happened', !handed.sure);

  const alt = new Screen({ cols: 80, rows: 24 });
  alt.write('\x1b[H\x1b[2Jat the prompt');
  const beneath = alt.digest();
  alt.write('\x1b[?1049h\x1b[H\x1b[2Jsome pager, filling the screen');
  check('the alternate screen is a different screen', alt.digest() !== beneath);
  alt.write('\x1b[?1049l');
  check('and leaving it puts back the one that was underneath', alt.digest() === beneath);

  const idle = new Screen({ cols: 120, rows: 24 });
  idle.write('\x1b[H\x1b[2J\x1b[20;1H  the last thing it said\x1b[22;100H255556 token\x1b[24;1H❯ ');
  const looked = idle.snapshot();
  const wasOnIt = idle.digest();
  idle.write('\x1b[22;100H            \x1b[22;60Hnew task? /clear to save 256.6k tokens');
  check('a footer rewritten where a footer already was is not news', !isNews(looked, idle.snapshot()));
  check('though the screen really did change, and stayed changed', idle.digest() !== wasOnIt);

  idle.write('\x1b[21;1H  and then it said something');
  check('a line where there was no line is news', isNews(looked, idle.snapshot()));

  const creep = new Screen({ cols: 80, rows: 10 });
  creep.write('\x1b[H\x1b[2Jone\r\ntwo\r\nthree\r\nfour');
  const start = creep.snapshot();
  creep.write('\x1b[1;1H1st');
  check('one row rewritten in place is a status line', !isNews(start, creep.snapshot()));
  creep.write('\x1b[2;1H2nd');
  check('two rows rewritten in place is a status block', !isNews(start, creep.snapshot()));
  creep.write('\x1b[3;1H3rd  ');
  check('three is a program drawing', isNews(start, creep.snapshot()));

  // Three rows repainted ten times a second is an animation, not a program
  // drawing something to be read — codex 0.154 draws a field of braille dots
  // behind its composer, in greys a shade off the background, and never stops.
  const dusty = new Screen({ cols: 80, rows: 10 });
  dusty.write('\x1b[H\x1b[2Jwhat it said before\r\n❯ ', 1000);
  let clock = 1000;
  const puff = (n) =>
    [8, 9, 10]
      .map((row, i) => `\x1b[${row};1H\x1b[K${' '.repeat((n * (3 + i * 5) + i * 7) % 40)}⠁`)
      .join('');
  dusty.write(puff(0), (clock += 90));
  const glanced = dusty.snapshot();
  for (let n = 1; n <= 12; n++) dusty.write(puff(n), (clock += 90));

  check('dust still moving is not an answer either way', isNews(glanced, dusty.snapshot(), { settledBy: clock - 500 }) === MOVING);
  check('and to a caller with no clock it is news, as it always was', isNews(glanced, dusty.snapshot()) === true);

  dusty.write('\x1b[4;1H  the build failed', (clock += 90));
  for (let n = 13; n <= 20; n++) dusty.write(puff(n), (clock += 90));
  check('a line printed behind the dust is news while it is still falling', isNews(glanced, dusty.snapshot(), { settledBy: clock - 500 }) === true);

  check('and dust that stops is a change like any other', isNews(glanced, dusty.snapshot(), { settledBy: clock + 500 }) === true);

  const status = new Screen({ cols: 80, rows: 10 });
  status.write('\x1b[H\x1b[2Jone\r\ntwo\r\nthree\r\nfour', 1000);
  const read = status.snapshot();
  status.write('\x1b[1;1H1st', 2000);
  check('a status line that has settled is no news, as before', isNews(read, status.snapshot(), { settledBy: 2500 }) === false);

  // A row written once and still warm is a line somebody printed, not an
  // animation — waiting for that one to settle would lose it if the daemon
  // stood down in between.
  const printed = new Screen({ cols: 80, rows: 10 });
  printed.write('\x1b[H\x1b[2J$ ', 1000);
  const atPrompt = printed.snapshot();
  printed.write('\x1b[5;1Hthe build failed', 2000);
  check('a line printed a moment ago is news at once, not once it settles', isNews(atPrompt, printed.snapshot(), { settledBy: 1900 }) === true);
  check('and three rows written once each are a program drawing, warm or not', (() => {
    const drawing = new Screen({ cols: 80, rows: 10 });
    drawing.write('\x1b[H\x1b[2Jone\r\ntwo\r\nthree\r\nfour', 1000);
    const looked = drawing.snapshot();
    drawing.write('\x1b[1;1H1st\x1b[2;1H2nd\x1b[3;1H3rd', 2000);
    return isNews(looked, drawing.snapshot(), { settledBy: 1900 }) === true;
  })());

  const inPlace = new Screen({ cols: 80, rows: 10 });
  inPlace.write('\x1b[H\x1b[2Jdownloading… 99%');
  const during = inPlace.snapshot();
  inPlace.write('\r\x1b[Kdone: saved to the file');
  check('a line overwritten where a line already was is not news either', !isNews(during, inPlace.snapshot()));

  const erased = new Screen({ cols: 80, rows: 10 });
  erased.write('\x1b[H\x1b[2Jkept\r\ngoing away');
  const both = erased.snapshot();
  erased.write('\x1b[2;1H\x1b[K');
  check('a line gone from where there was one is news', isNews(both, erased.snapshot()));

  const scrolled = new Screen({ cols: 80, rows: 6 });
  scrolled.write('\x1b[H\x1b[2Ja\r\nb\r\nc\r\nd\r\ne\r\nf');
  const before = scrolled.snapshot();
  scrolled.write('\r\ng');
  check('a screen that has scrolled is news', isNews(before, scrolled.snapshot()));

  const borrowed = new Screen({ cols: 80, rows: 10 });
  borrowed.write('\x1b[H\x1b[2Jat the prompt');
  const under = borrowed.snapshot();
  borrowed.write('\x1b[?1049h\x1b[H\x1b[2Jat the prompt');
  check('the same text on the alternate screen is still news', isNews(under, borrowed.snapshot()));

  check('the swap is found in a mode list', lastScreenSwap('x\x1b[?1049;1000h').borrowed);
  check('and in the two forms that came before it', lastScreenSwap('\x1b[?47h').borrowed && !lastScreenSwap('\x1b[?1047l').borrowed);
  check('the last of them is the one that counts', !lastScreenSwap('\x1b[?1049h\x1b[2J\x1b[?1049l').borrowed);
  check('a tab that never borrowed the screen has none', lastScreenSwap('\x1b[?25l\x1b[H hello \x1b[?25h') === null);
}

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

  let browser = null;
  for (const options of [{}, { channel: 'chrome' }]) {
    try {
      browser = await chromium.launch(options);
      break;
    } catch {
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

    const real = await drawn(page, recording, cols, rows);

    const ours = model.text();
    const off = [];
    for (let y = 0; y < rows; y++) if (ours[y] !== real[y]) off.push(y);
    check(
      what,
      off.length === 0,
      off.length ? `row ${off[0]}: ${JSON.stringify(ours[off[0]])} not ${JSON.stringify(real[off[0]])}` : '',
    );
  }

  const beneath = '\x1b[H\x1b[2Juser@host:~/work [main]\r\n$ claude\r\n';
  const swap = '\x1b7\x1b[?1049h\x1b[2J\x1b[H';
  const frame = "\x1b[H  a line of the conversation\x1b[10;1H❯ typed here\x1b[12;1H✻ Sautéed for 5m 23s";
  const leaving = '\x1b[?1049l\x1b[?25h\r\nResume this session with: claude --resume 1234\r\n$ ';

  const kept = await drawn(page, beneath + swap + frame + leaving, cols, rows);
  check(
    'a program that gives the screen back leaves the command that started it',
    kept.some((line) => line.includes('$ claude')) && !kept.some((line) => line.includes('a line of the conversation')),
    JSON.stringify(kept.filter(Boolean).slice(0, 4)),
  );

  const lost = await drawn(page, frame + leaving, cols, rows);
  check(
    'and without the swap in the recording its frame is still on the screen',
    lost.some((line) => line.includes('a line of the conversation')),
    JSON.stringify(lost.filter(Boolean).slice(0, 4)),
  );

  await browser.close();
}

function drawn(page, recording, cols, rows) {
  return page.evaluate(
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
}

function recordingTests() {
  console.log('\n3. the recording, once there is more of it than fits');

  const prompt = '\x1b[32muser@host:\x1b[33m~/work\x1b[0m [main]\r\r\n$ claude\r\n';
  const session = new Session({ id: 'recording' });
  session.append(prompt);
  session.append('\x1b[?2004l\r\n\x1b7\x1b[r\x1b8\x1b[?1049h\x1b[2J\x1b[H\x1b[?1000h');
  check('the screen underneath is set aside the moment it is borrowed', session.underneath.length > 0);

  for (let i = 0; i < 12000; i++) {
    session.append(`\x1b[?25l\x1b[H\r\x1b[60C\x1b[19B${250000 + i} tokens\x1b[24;1H\x1b[22;3H\x1b[?25h`);
  }
  const recording = session.scrollback();
  check('a tab that has written far too much is trimmed as ever', Buffer.byteLength(recording) <= 512 * 1024);
  check('the newest frames are what is kept', recording.includes('261999 tokens'));
  check('and the oldest are gone', !recording.includes('250000 tokens'));
  check('but the swap is still in it', recording.includes('\x1b[?1049h'));
  check('and so is the command that caused it', recording.includes('$ claude'));

  session.append('\x1b[?1049l\x1b[?25h\r\nback at the prompt\r\n$ ');
  check('giving the screen back joins them up', session.underneath.length === 0);
  check('and what was underneath is still there to be read', session.scrollback().includes('$ claude'));
  for (let i = 0; i < 12000; i++) session.append(`line ${i} of something ordinary\r\n`);
  check('after which it is trimmed like anything else', !session.scrollback().includes('$ claude'));

  const plain = new Session({ id: 'plain' });
  plain.append('the first thing it said\r\n');
  for (let i = 0; i < 30000; i++) plain.append(`line ${i} of a build\r\n`);
  check('a tab with nothing borrowed keeps nothing back', plain.underneath.length === 0);
  check('and drops its oldest output', !plain.scrollback().includes('the first thing it said'));

  const seeded = new Session({ id: 'seeded' });
  seeded.seedScrollback(recording);
  check('a recording read back off the disk is split where it was written', seeded.underneath.length > 0);
  for (let i = 0; i < 12000; i++) {
    seeded.append(`\x1b[?25l\x1b[H\r\x1b[60C\x1b[19B${350000 + i} tokens\x1b[24;1H\x1b[22;3H\x1b[?25h`);
  }
  check('so the swap survives the next trim too', seeded.scrollback().includes('\x1b[?1049h'));
  check('and the command with it', seeded.scrollback().includes('$ claude'));
}

const TMP = mkdtempSync(join(tmpdir(), 'clio-unseen-'));
const RUN = join(TMP, 'run');
const STATE = join(TMP, 'state');
const BIN = join(TMP, 'bin');
const WORK = join(TMP, 'work');
const HOME = join(TMP, 'home');
for (const dir of [RUN, STATE, BIN, WORK, HOME]) mkdirSync(dir, { recursive: true });

const env = {
  ...process.env,
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

async function daemonAfter(oldPid, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const info = handshake();
      if (info.pid !== oldPid && alive(info.pid)) return info;
    } catch {
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

  console.log(`\n4. a tab nobody is looking at    (sandbox at ${TMP})`);
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

  await sleep(800);
  client.send({ t: 'focus', id: painting.id });
  await sleep(200);
  client.send({ t: 'input', id: painting.id, data: `exec node ${fixture}\n` });

  await sleep(1200);
  client.send({ t: 'focus', id: other.id });
  await sleep(300);
  client.everRed.delete(painting.id);
  check('the tab being painted in is not red while it is being looked at', !client.red(painting.id));

  client.send({ t: 'input', id: painting.id, data: 'v' });
  await sleep(3000);
  check('a repaint that puts the screen back does not turn the tab red', !client.red(painting.id));
  check('and it never went red in the meantime either', !client.everRed.has(painting.id));

  client.send({ t: 'input', id: painting.id, data: 'h' });
  await sleep(2500);
  client.send({ t: 'input', id: painting.id, data: 'h' });
  await sleep(2500);
  check('a footer that changes and stays changed does not turn it red either',
    !client.red(painting.id) && !client.everRed.has(painting.id));

  client.send({ t: 'input', id: painting.id, data: 'n' });
  await sleep(2500);
  check('a line nobody has read does turn it red', client.red(painting.id));

  client.send({ t: 'focus', id: painting.id });
  await sleep(400);
  check('and looking at the tab puts the red out', !client.red(painting.id));

  client.send({ t: 'input', id: painting.id, data: 'd' });
  await sleep(600);
  client.send({ t: 'focus', id: other.id });
  await sleep(400);
  client.everRed.delete(painting.id);
  await sleep(4000);
  check('three rows of dust, ten times a second, do not turn the tab red',
    !client.red(painting.id) && !client.everRed.has(painting.id));

  client.send({ t: 'input', id: painting.id, data: 'n' });
  await sleep(3000);
  check('and a line printed behind the dust still does', client.red(painting.id));

  client.send({ t: 'input', id: painting.id, data: 'd' });
  client.send({ t: 'focus', id: painting.id });
  await sleep(600);
  check('looking at it puts that red out too', !client.red(painting.id));

  console.log('\n5. and after a reload, on a screen this daemon never saw');
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

  console.log('\n6. output that arrives just as the daemon is standing down');
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

  console.log('\n7. a restart, and the tabs that come back from it');
  await sleep(3500);
  const beforeRestart = last.pid;
  client.close();
  execFileSync(join(ROOT, 'bin', 'clio'), ['stop'], { env, stdio: 'ignore' });
  execFileSync(join(ROOT, 'bin', 'clio'), ['start'], { env, stdio: 'ignore' });
  const restored = await daemonAfter(beforeRestart);
  check('a daemon is running again', !!restored && restored.pid !== beforeRestart);
  if (!restored) return;

  client = new Client(restored, '0ff1ce00');
  await client.connect();
  await client.await((m) => m.t === 'sessions');
  await sleep(6000);
  check('both tabs came back', client.sessions.length === 2, `${client.sessions.length} tab(s)`);
  check('and neither of them is red', !client.red(painting.id) && !client.red(other.id));
  check('nor was either of them on the way back',
    !client.everRed.has(painting.id) && !client.everRed.has(other.id));

  await sleep(11000);
  client.send({ t: 'input', id: painting.id, data: 'echo something-new\n' });
  await sleep(2500);
  check('a line typed into one afterwards still turns it red', client.red(painting.id));
  check('and the tab beside it is left alone', !client.red(other.id));

  client.close();
}

function report() {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) console.log(`\n---- daemon log ----\n${log.join('')}`);
  stop();
  process.exit(failed ? 1 : 0);
}

function stop() {
  try {
    const running = handshake().pid;
    if (running !== daemon?.pid) process.kill(running, 'SIGKILL');
  } catch {
  }
  if (!daemon) return;
  try {
    daemon.kill('SIGKILL');
  } catch {
  }
  daemon = null;
}
process.on('exit', stop);

async function main() {
  screenTests();
  await terminalTests();
  recordingTests();
  await daemonTests();
  report();
}

main().catch((err) => {
  console.error(err);
  failed++;
  report();
});
