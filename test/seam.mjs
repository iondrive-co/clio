import { chromium } from 'playwright';
import { mkdirSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const XTERM = join(ROOT, 'node_modules', '@xterm', 'xterm', 'lib', 'xterm.js');

const SANDBOX = mkdtempSync(join(tmpdir(), 'clio-seam-'));
process.env.XDG_RUNTIME_DIR = join(SANDBOX, 'run');
process.env.XDG_STATE_HOME = join(SANDBOX, 'state');
process.env.CLIO_DEV = '1';
process.env.CLIO_NO_UI_WATCH = '1';
mkdirSync(process.env.XDG_RUNTIME_DIR, { recursive: true });
mkdirSync(process.env.XDG_STATE_HOME, { recursive: true });
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
  }
  try {
    rmSync(SANDBOX, { recursive: true, force: true });
  } catch {
  }
});

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

  async type(id, line, settle = 1200) {
    this.send({ t: 'input', id, data: `${line}\n` });
    await sleep(settle);
  }

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
    }
  }
}

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

const PAINTER =
  `node -e 'process.stdout.write("\\x1b[2J\\x1b[H");` +
  ` for (let r = 1; r <= 20; r++) process.stdout.write("\\x1b[" + r + ";1HFRAME ROW " + r);` +
  ` process.stdout.write("\\x1b[12;1H> half a question, never sent");` +
  ` setInterval(() => {}, 1 << 30)'`;

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

const before = new Client();
await before.connect();

const plain = await before.create();
const painted = await before.create();
const alternate = await before.create();
await sleep(1500);

await before.type(plain, 'echo before-the-crash');
await before.type(painted, PAINTER);
await before.type(alternate, ALTERNATE);
await sleep(2500);
before.close();

process.kill(handshake().pid, 'SIGKILL');
await sleep(1000);
clio('start');
await sleep(3500);

const after = new Client(before.container);
await after.connect();
check('all three tabs came back', after.sessions.length === 3, `${after.sessions.length} tabs`);

for (const id of [plain, painted, alternate]) await after.type(id, 'echo after-the-crash', 800);
await sleep(800);

const screens = new Map();
for (const id of [plain, painted, alternate]) {
  screens.set(id, await terminal.render(await after.replay(id)));
}
after.close();
await terminal.close();

const rowOf = (lines, text) => lines.findIndex((line) => line.includes(text));
const rowsWith = (lines, text) =>
  lines.map((line, i) => (line.includes(text) ? i : -1)).filter((i) => i >= 0);
const show = (lines) => JSON.stringify(lines.filter(Boolean).slice(0, 8));

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
