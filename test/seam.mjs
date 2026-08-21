/*
 * What a restored tab looks like, as opposed to what is in it.
 *
 * Everything else that tests the restore asks what came back — the scrollback,
 * the directory, the note saying what was running. All of that can be right
 * while the tab is unreadable, because a terminal is not a list of lines: where
 * text lands is decided by escape sequences, and the last thing a killed
 * program wrote was almost never a newline. On 21 August a restored tab came
 * back with the dead program's screen still covering it and the seam, the new
 * prompt and everything typed afterwards written from the top of the screen
 * down, threaded through the old text a line at a time.
 *
 * Nothing in the bytes was wrong. Two of the mode resets clio writes ahead of
 * the seam move the cursor to the top left, and only a terminal knows that. So
 * this test puts the replay through one — real xterm.js, the same build the
 * windows run — and reads the screen rather than the stream.
 *
 * Runs a clio of its own, on its own state:
 *
 *   node test/seam.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const XTERM = join(ROOT, 'node_modules', '@xterm', 'xterm', 'lib', 'xterm.js');

// This test kills the daemon it is pointed at, which ends every shell in it.
// Its own, then, from the first line: made here, before anything can inherit
// the caller's.
const SANDBOX = mkdtempSync(join(tmpdir(), 'clio-seam-'));
process.env.XDG_RUNTIME_DIR = join(SANDBOX, 'run');
process.env.XDG_STATE_HOME = join(SANDBOX, 'state');
process.env.CLIO_DEV = '1';
process.env.CLIO_NO_UI_WATCH = '1';
mkdirSync(process.env.XDG_RUNTIME_DIR, { recursive: true });
mkdirSync(process.env.XDG_STATE_HOME, { recursive: true });
// Nothing here opens a window, and nothing here may open one on the desktop of
// whoever is running it.
delete process.env.DISPLAY;
delete process.env.WAYLAND_DISPLAY;

const HANDSHAKE = join(process.env.XDG_RUNTIME_DIR, 'clio', 'daemon.json');
const COLS = 80;
const ROWS = 24;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clio = (...args) =>
  execFileSync(join(ROOT, 'bin', 'clio'), args, { encoding: 'utf8', env: process.env });
const handshake = () => JSON.parse(readFileSync(HANDSHAKE, 'utf8'));

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

process.on('exit', () => {
  try {
    clio('stop');
  } catch {
    /* never started, or already down */
  }
  try {
    rmSync(SANDBOX, { recursive: true, force: true });
  } catch {
    /* leave it, it is in /tmp */
  }
});

/** A stand-in for a browser window: connects, types, and reads tabs back. */
class Client {
  constructor(container = null) {
    this.container = container;
    this.sessions = [];
    this.replays = new Map();
  }

  async connect() {
    const { port, token } = handshake();
    const query = `?token=${token}${this.container ? `&c=${this.container}` : ''}`;
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/${query}`, {
      origin: `http://127.0.0.1:${port}`,
    });
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.t === 'sessions') {
        this.container = msg.container;
        this.sessions = msg.sessions;
      }
      if (msg.t === 'created') this.created = msg.id;
      if (msg.t === 'attached') this.replays.set(msg.id, msg.scrollback || '');
    });
    await new Promise((resolve, reject) => {
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
    });
    await sleep(400);
  }

  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }

  async create() {
    this.created = null;
    this.send({ t: 'create', cols: COLS, rows: ROWS });
    for (let i = 0; i < 50 && !this.created; i++) await sleep(100);
    return this.created;
  }

  /** Type a line and give the shell a moment to answer it. */
  async type(id, line, settle = 1200) {
    this.send({ t: 'input', id, data: `${line}\n` });
    await sleep(settle);
  }

  /** What a window opening on this tab would be replayed. */
  async replay(id) {
    this.replays.delete(id);
    this.send({ t: 'attach', id, cols: COLS, rows: ROWS });
    for (let i = 0; i < 50 && !this.replays.has(id); i++) await sleep(100);
    return this.replays.get(id) ?? '';
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }
}

/**
 * A terminal to read the answer off, or null if this machine cannot start one.
 *
 * The pinned build first, so a CI box uses the browser the project installed;
 * the desktop's own Chrome after it, because a machine that has never run
 * `playwright install` still has one and this test is worth running there.
 */
async function openTerminal() {
  const tries = [{}, { channel: 'chrome' }];
  for (const options of tries) {
    let browser;
    try {
      browser = await chromium.launch(options);
    } catch {
      continue;
    }
    const page = await browser.newPage();
    await page.setContent('<div id="screen"></div>');
    await page.addScriptTag({ path: XTERM });
    /** Write a recording into a fresh terminal and read the screen back. */
    const render = (text) =>
      page.evaluate(
        async ({ text, cols, rows }) => {
          const host = document.getElementById('screen');
          host.innerHTML = '';
          const term = new window.Terminal({ cols, rows, scrollback: 10000 });
          term.open(host);
          await new Promise((resolve) => term.write(text, resolve));
          const buffer = term.buffer.active;
          const lines = [];
          for (let i = 0; i < buffer.length; i++) {
            lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
          }
          return lines;
        },
        { text, cols: COLS, rows: ROWS },
      );
    return { render, close: () => browser.close() };
  }
  return null;
}

/*
 * A full-screen program on the ordinary screen — which is where an agent lives,
 * and the case the seam was getting wrong. It paints with absolute positioning
 * and leaves the cursor in the middle of its own frame, where a person had
 * started typing an answer to it.
 *
 * `node -e` rather than a file on purpose: a script would be restarted on
 * restore and would paint over its own seam, and what is being read here is
 * where clio put the seam, not what the program did next.
 */
const PAINTER =
  `node -e 'process.stdout.write("\\x1b[2J\\x1b[H");` +
  ` for (let r = 1; r <= 20; r++) process.stdout.write("\\x1b[" + r + ";1HFRAME ROW " + r);` +
  ` process.stdout.write("\\x1b[12;1H> half a question, never sent");` +
  ` setInterval(() => {}, 1 << 30)'`;

/* And one on the alternate screen, the way vim and less do it. */
const ALTERNATE =
  `node -e 'process.stdout.write("\\x1b[?1049h\\x1b[2J\\x1b[H");` +
  ` for (let r = 1; r <= 20; r++) process.stdout.write("\\x1b[" + r + ";1HALT ROW " + r);` +
  ` setInterval(() => {}, 1 << 30)'`;

console.log(`clio seam test — sandbox at ${SANDBOX}`);

const terminal = await openTerminal();
if (!terminal) {
  console.log('no browser to render a terminal in — nothing to test');
  process.exit(0);
}

clio('start');
await sleep(2500);

// ---- three tabs, killed mid-sentence -------------------------------------
const before = new Client();
await before.connect();

const plain = await before.create();
const painted = await before.create();
const alternate = await before.create();
await sleep(1500); // the profiles

await before.type(plain, 'echo before-the-crash');
await before.type(painted, PAINTER);
await before.type(alternate, ALTERNATE);
await sleep(2500); // past the scrollback flush, so the kill below cannot lose it
before.close();

process.kill(handshake().pid, 'SIGKILL');
await sleep(1000);
clio('start');
await sleep(3500);

const after = new Client(before.container);
await after.connect();
check('all three tabs came back', after.sessions.length === 3, `${after.sessions.length} tabs`);

// Somebody comes back to the rebuilt window and uses it. Typed before the
// screens are read so that the new shell's own output is in them: a seam with
// nothing under it proves only half of this.
for (const id of [plain, painted, alternate]) await after.type(id, 'echo after-the-crash', 800);
await sleep(800);

const screens = new Map();
for (const id of [plain, painted, alternate]) {
  screens.set(id, await terminal.render(await after.replay(id)));
}
after.close();
await terminal.close();

/** Which line of the screen something is on, or -1. */
const rowOf = (lines, text) => lines.findIndex((line) => line.includes(text));
const rowsWith = (lines, text) =>
  lines.map((line, i) => (line.includes(text) ? i : -1)).filter((i) => i >= 0);
const show = (lines) => JSON.stringify(lines.filter(Boolean).slice(0, 8));

/*
 * The rule, in all three tabs: the old text is above the seam and the new text
 * is below it, and nothing has been written through anything else.
 */
for (const [name, id, oldText] of [
  ['a shell at its prompt', plain, 'before-the-crash'],
  ['a full-screen program', painted, 'FRAME ROW 1'],
  ['a program on the alternate screen', alternate, ALTERNATE.slice(0, 12)],
]) {
  console.log(`\n${name}`);
  const lines = screens.get(id);
  const seam = rowOf(lines, '──── new shell');
  const old = rowOf(lines, oldText);
  const fresh = rowOf(lines, 'after-the-crash');

  check('the seam is there', seam >= 0, show(lines));
  check('what was in the tab before the crash is still there', old >= 0, show(lines));
  check('it is above the seam', old >= 0 && seam > old, `old on ${old}, seam on ${seam}`);
  check(
    'and what has happened since is below it',
    fresh > seam,
    `seam on ${seam}, new output on ${fresh}`,
  );
}

/*
 * The frame in detail, because "above the seam" is not the whole of it: a
 * restore that left the seam at the bottom of the old screen would pass that
 * and still be a screen with the dead program's last frame all over it.
 */
console.log('\nthe dead frame itself');
const frame = screens.get(painted);
const seam = rowOf(frame, '──── new shell');
const kept = [];
for (let r = 1; r <= 11; r++) kept.push(rowOf(frame, `FRAME ROW ${r}`) === r - 1);
check('every row the program drew above its cursor is where it drew it', kept.every(Boolean),
  JSON.stringify(frame.slice(0, 12)));
check(
  'the line it left the cursor on is kept, and only what it wrote is on it',
  frame[11] === '> half a question, never sent',
  JSON.stringify(frame[11]),
);
check(
  'the rest of the frame — the part the new shell would have been printed through — is gone',
  rowsWith(frame, 'FRAME ROW').every((row) => row < seam),
  JSON.stringify(rowsWith(frame, 'FRAME ROW')),
);
check('and the seam is on the first line after it', seam === 12, `seam on ${seam}`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
