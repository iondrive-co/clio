/*
 * Opening a link from a tab.
 *
 * It goes to the desktop's own opener, which puts it in a tab of the browser
 * already on screen — or to a browser chosen by name from the menu, which is
 * the second half of this file. The rest is about what does *not* go there: the
 * text in a terminal is the output of whatever ran last, so a link in it is not
 * something the person clicking wrote, and only the schemes a click could
 * sensibly mean are passed on.
 *
 * Runs a sandbox daemon of its own, with a recorder standing in for xdg-open
 * and a directory of .desktop files standing in for the browsers installed.
 *
 *   node test/links.mjs
 */
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
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
const ran = join(dir, 'ran.txt');
const runner = join(dir, 'record-args');
const apps = join(dir, 'data', 'applications');

// Standing in for xdg-open: writes down what it was asked to open, so the test
// can look at the argument rather than at a browser appearing on somebody's
// desktop.
writeFileSync(opener, `#!/bin/sh\nprintf '%s\\n' "$1" >> ${opened}\n`);
chmodSync(opener, 0o755);

// And standing in for the browsers themselves, which are .desktop files as far
// as any of this is concerned. This one writes down every argument, because
// where a browser's own arguments end and the URL begins is the thing being
// checked.
writeFileSync(runner, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${ran}\n`);
chmodSync(runner, 0o755);

mkdirSync(apps, { recursive: true });

const DESKTOP_FILES = {
  // An ordinary browser, with an action group after the entry: the Name in
  // there belongs to a menu item of the browser's own, not to the browser.
  'fakefox.desktop': `[Desktop Entry]
Type=Application
Name=Fakefox
Exec=${runner} fakefox --new-tab %u
MimeType=text/html;x-scheme-handler/http;x-scheme-handler/https;

[Desktop Action private]
Name=Private Window
Exec=${runner} fakefox --private %u
`,
  // Says nothing about http; files itself under WebBrowser, as Firefox does on
  // the machine this was written on.
  'catbrowser.desktop': `[Desktop Entry]
Type=Application
Name=Cat Browser
Categories=Network;WebBrowser;
Exec=${runner} catbrowser %U
`,
  // Plumbing: the second entry a package ships to own a MIME type.
  'hidden.desktop': `[Desktop Entry]
Type=Application
Name=Hidden Browser
NoDisplay=true
Exec=${runner} hidden %u
MimeType=x-scheme-handler/http;
`,
  // A browser whose package has gone, leaving its entry behind.
  'ghost.desktop': `[Desktop Entry]
Type=Application
Name=Ghost
Exec=${join(dir, 'not-installed')} %u
MimeType=x-scheme-handler/http;
`,
  // The desktop's own launcher. Following it arrives at the default, which is
  // where a link goes with nobody choosing anything.
  'indirect.desktop': `[Desktop Entry]
Type=Application
Name=Web Browser
Exec=xdg-open %u
MimeType=x-scheme-handler/http;
`,
  // Opens HTML files. Not a browser, and not a thing to offer a link to.
  'editor.desktop': `[Desktop Entry]
Type=Application
Name=Editor
Exec=${runner} editor %f
MimeType=text/html;text/plain;
`,
};

for (const [name, body] of Object.entries(DESKTOP_FILES)) {
  writeFileSync(join(apps, name), body);
}

const env = {
  ...process.env,
  XDG_RUNTIME_DIR: join(dir, 'run'),
  XDG_STATE_HOME: join(dir, 'state'),
  // The browsers this run can see, and nowhere else to look for more: the real
  // ones on the machine running the test are not something to assert about.
  XDG_DATA_HOME: join(dir, 'data'),
  XDG_DATA_DIRS: join(dir, 'nothing-here'),
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

function lines(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
}

function recorded() {
  return lines(opened);
}

/**
 * What the opener was handed, once it has had a moment to be handed it.
 *
 * `browser` names one by the id the daemon gave the window, in which case the
 * browser's own recorder is the one that will have written something down.
 */
async function opensWith(ws, url, timeout = 1500, browser = null, file = opened) {
  const before = lines(file).length;
  ws.send(JSON.stringify({ t: 'openurl', url, ...(browser ? { browser } : {}) }));
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const now = lines(file);
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
  // Kept out of the list above, which is emptied between checks: this one
  // arrives once, on connect, and is still the answer long after.
  let listed = null;
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.t === 'browsers') listed = msg;
    messages.push(msg);
  });
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

  // A menu that offers a browser by name has to be a menu of browsers that are
  // here. The daemon reads that off the same .desktop files the desktop's own
  // Open With is built from, so this section gives it a directory of them.
  console.log('\n4. the browsers this machine has');
  const names = (listed?.browsers || []).map((b) => b.name);
  check('a window is told what they are when it connects', !!listed);
  check('and it is the ones that can be run', JSON.stringify(names) === '["Cat Browser","Fakefox"]', names.join(', '));
  check(
    'a browser is named by its own Name, not an action of its own',
    !names.includes('Private Window'),
  );

  console.log('\n5. opening in one of them by name');
  // Everything the desktop has been handed up to here. Naming a browser goes
  // straight to it, and nothing below should add to this.
  const defaultOpens = recorded().length;
  const fakefox = (listed?.browsers || []).find((b) => b.name === 'Fakefox');
  check(
    'the browser is started with the arguments its .desktop file gives it',
    (await opensWith(ws, 'https://example.com/a?b=c', 1500, fakefox?.id, ran)) ===
      `fakefox --new-tab https://example.com/a?b=c`,
  );
  const cat = (listed?.browsers || []).find((b) => b.name === 'Cat Browser');
  check(
    'and a URL lands where the field code says',
    (await opensWith(ws, 'https://example.com/', 1500, cat?.id, ran)) === 'catbrowser https://example.com/',
  );
  check(
    'the desktop is not asked as well',
    recorded().length === defaultOpens,
    `${recorded().length - defaultOpens} extra`,
  );

  console.log('\n6. and a browser that is not there');
  messages.length = 0;
  // The id comes back from the window, which was told it by the daemon — but a
  // window is a page, and a page saying anything at all is a page that could be
  // saying something else. Nothing runs but an entry found by looking the id up.
  for (const id of ['ghost.desktop', '../../../bin/sh', 'sh -c id']) {
    check(`${id} opens nothing`, (await opensWith(ws, 'https://example.com/', 700, id, ran)) === null);
  }
  check('and the window is told why', messages.some((m) => m.t === 'link' && m.ok === false));
  check(
    'a link the desktop would not be given is not given to a browser either',
    (await opensWith(ws, 'file:///etc/passwd', 700, fakefox?.id, ran)) === null,
  );

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
