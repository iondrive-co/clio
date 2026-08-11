/*
 * Clicking a link in a tab.
 *
 * It goes to the desktop's own opener, which puts it in a tab of the browser
 * already on screen. The rest of this file is about what does *not* go there:
 * the text in a terminal is the output of whatever ran last, so a link in it is
 * not something the person clicking wrote, and only the schemes a click could
 * sensibly mean are passed on.
 *
 * Runs a sandbox daemon of its own, with a recorder standing in for xdg-open.
 *
 *   node test/links.mjs
 */
import { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLIO = join(REPO, 'bin', 'clio');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const dir = mkdtempSync(join(tmpdir(), 'clio-links-'));
const opened = join(dir, 'opened.txt');
const opener = join(dir, 'record-url');

// Standing in for xdg-open: writes down what it was asked to open, so the test
// can look at the argument rather than at a browser appearing on somebody's
// desktop.
writeFileSync(opener, `#!/bin/sh\nprintf '%s\\n' "$1" >> ${opened}\n`);
chmodSync(opener, 0o755);

const env = {
  ...process.env,
  XDG_RUNTIME_DIR: join(dir, 'run'),
  XDG_STATE_HOME: join(dir, 'state'),
  CLIO_DEV: '1',
  CLIO_URL_OPENER: opener,
};
const HANDSHAKE = join(dir, 'run', 'clio', 'daemon.json');

function tearDown() {
  try {
    execFileSync(CLIO, ['stop'], { env, stdio: 'ignore' });
  } catch {
    /* never started */
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* leave it */
  }
}
process.on('exit', tearDown);

function recorded() {
  if (!existsSync(opened)) return [];
  return readFileSync(opened, 'utf8').trim().split('\n').filter(Boolean);
}

/** What the opener was handed, once it has had a moment to be handed it. */
async function opensWith(ws, url, timeout = 1500) {
  const before = recorded().length;
  ws.send(JSON.stringify({ t: 'openurl', url }));
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const now = recorded();
    if (now.length > before) return now[now.length - 1];
    await sleep(50);
  }
  return null;
}

async function main() {
  execFileSync(CLIO, ['start'], { env, stdio: 'ignore' });
  await sleep(600);
  const info = JSON.parse(readFileSync(HANDSHAKE, 'utf8'));
  console.log(`sandbox daemon on port ${info.port}\n`);

  const container = randomBytes(4).toString('hex');
  const origin = `http://127.0.0.1:${info.port}`;
  const ws = new WebSocket(`ws://127.0.0.1:${info.port}/?token=${info.token}&c=${container}`, {
    origin,
  });
  const messages = [];
  ws.on('message', (raw) => messages.push(JSON.parse(raw)));
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  console.log('1. a link goes to the desktop');
  check('an http link is opened', (await opensWith(ws, 'http://example.com/')) === 'http://example.com/');
  check(
    'a query string survives intact',
    (await opensWith(ws, 'https://example.com/a?b=c&d=e#f')) === 'https://example.com/a?b=c&d=e#f',
  );
  check('mailto goes too', (await opensWith(ws, 'mailto:someone@example.com')) === 'mailto:someone@example.com');

  console.log('\n2. and what does not');
  // A terminal shows whatever a program printed. None of these are worth the
  // risk of handing to whatever the desktop has registered for them.
  for (const url of [
    'javascript:alert(1)',
    'file:///etc/passwd',
    'data:text/html,<script>1</script>',
    'not a url at all',
  ]) {
    messages.length = 0;
    check(`${url.slice(0, 28)} is refused`, (await opensWith(ws, url, 700)) === null);
    check('  and the window is told why', messages.some((m) => m.t === 'link' && m.ok === false));
  }

  // The shell argument that never was: a URL is parsed before it is passed on,
  // so there is nothing here for a shell to expand — there is no shell.
  console.log('\n3. nothing reaches a shell');
  const sneaky = 'https://example.com/$(touch /tmp/clio-should-not-exist)';
  const got = await opensWith(ws, sneaky);
  check('a URL with shell syntax in it is passed through verbatim', !!got, got || 'not opened');
  check('and nothing ran', !existsSync('/tmp/clio-should-not-exist'));

  ws.close();
}

main()
  .catch((err) => {
    failed++;
    console.error('\nthe test itself failed:', err);
  })
  .finally(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  });
