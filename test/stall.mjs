import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';

const SANDBOX = mkdtempSync(join(tmpdir(), 'clio-stall-'));
process.env.XDG_RUNTIME_DIR = join(SANDBOX, 'run');
process.env.XDG_STATE_HOME = join(SANDBOX, 'state');
process.env.CLIO_DEV = '1';
mkdirSync(process.env.XDG_RUNTIME_DIR, { recursive: true });
mkdirSync(process.env.XDG_STATE_HOME, { recursive: true });

const WRITE_MS = 1500;
const SCROLLBACK_DIR = join(process.env.XDG_STATE_HOME, 'clio', 'scrollback');
process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ''} --require ${resolve('test/slowdisk.cjs')}`.trim();
process.env.CLIO_SLOW_DISK_MS = String(WRITE_MS);
process.env.CLIO_SLOW_DISK_PATH = SCROLLBACK_DIR;

const HANDSHAKE = join(process.env.XDG_RUNTIME_DIR, 'clio', 'daemon.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

process.on('exit', () => {
  try {
    execSync('./bin/clio stop', { stdio: 'ignore' });
  } catch {
  }
  try {
    rmSync(SANDBOX, { recursive: true, force: true });
  } catch {
  }
});

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

class Window {
  constructor(info) {
    this.info = info;
    this.messages = [];
    this.output = '';
  }

  connect() {
    const origin = `http://127.0.0.1:${this.info.port}`;
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${this.info.port}/?token=${this.info.token}`, {
        origin,
      });
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        const msg = JSON.parse(raw);
        this.messages.push(msg);
        if (msg.t === 'data' && msg.id === this.id) this.output += msg.data;
        if (msg.t === 'attached' && msg.id === this.id) this.output = msg.scrollback || '';
      });
    });
  }

  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }

  async openTab() {
    this.send({ t: 'create', cwd: process.env.HOME, cols: 100, rows: 30 });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const created = this.messages.find((m) => m.t === 'created');
      if (created) {
        this.id = created.id;
        this.send({ t: 'attach', id: this.id, cols: 100, rows: 30 });
        return this.id;
      }
      await sleep(20);
    }
    throw new Error('the daemon never opened a tab');
  }

  async probe(n) {
    const marker = `#${n}z`;
    const started = Date.now();
    this.send({ t: 'input', id: this.id, data: marker });
    const deadline = started + 20000;
    while (Date.now() < deadline) {
      if (this.output.includes(marker)) return Date.now() - started;
      await sleep(5);
    }
    return Infinity;
  }
}

async function main() {
  console.log(`sandbox at ${SANDBOX}`);
  console.log(`every write under ${SCROLLBACK_DIR} takes ${WRITE_MS}ms\n`);
  execSync('./bin/clio start', { stdio: 'ignore' });
  const info = JSON.parse(readFileSync(HANDSHAKE, 'utf8'));

  const window = new Window(info);
  await window.connect();
  await window.openTab();
  await sleep(1500);

  console.log('1. typing while the disk is refusing to answer');
  const round = [];
  for (let n = 0; n < 60; n++) {
    round.push(await window.probe(n));
    await sleep(200);
  }
  const sorted = [...round].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const worst = sorted[sorted.length - 1];
  const stalled = round.filter((ms) => ms > 500).length;
  console.log(`   median ${median}ms, worst ${worst}ms, ${stalled}/${round.length} over 500ms`);

  check('every keystroke came back', Number.isFinite(worst), `worst ${worst}`);
  check('typing is not held up by the disk', worst < 1000, `worst round trip ${worst}ms`);
  check('and is quick throughout', median < 200, `median ${median}ms`);

  console.log('\n2. the scrollback was still written');
  await sleep(WRITE_MS + 3500);
  const files = existsSync(SCROLLBACK_DIR) ? readdirSync(SCROLLBACK_DIR) : [];
  const log = files.find((f) => f === `${window.id}.log`);
  check('the tab has a scrollback file', !!log, files.join(', '));
  if (log) {
    const saved = readFileSync(join(SCROLLBACK_DIR, log), 'utf8');
    check('with what was typed into it in it', saved.includes('#59z'), `${saved.length} bytes`);
  }
  check(
    'and nothing was left half-written',
    !files.some((f) => f.endsWith('.writing') || f.endsWith('.tmp')),
    files.join(', '),
  );

  window.close?.();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
