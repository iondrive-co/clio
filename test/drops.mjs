/*
 * Files dragged into a window.
 *
 * A page is not told where a dropped file came from — Chrome hands over a name,
 * a size, a modification time and the bytes, and nothing else — so clio works
 * the path out in the daemon, and only asks the window for the contents of
 * files it could not find on disk. Two things have to be true for that to be
 * worth doing, and this file is about both: the path it types is the *real* one
 * whenever the file exists, and a file that exists nowhere still ends up as a
 * path that can be read.
 *
 * The second half drives a real page, because everything above the websocket —
 * the drop landing on the right tab, the bytes going up, the path being typed
 * into the shell rather than at it — only exists in the browser.
 *
 * Runs a sandbox daemon of its own, on a home directory of its own:
 *
 *   node test/drops.mjs
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
  existsSync,
  statSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { chromium } from 'playwright';

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

const dir = mkdtempSync(join(tmpdir(), 'clio-drops-'));

// A home directory of this test's own. locate() searches ~/Downloads and the
// rest of the XDG user directories, and it must be looking in these ones: the
// person running the tests has files in theirs, and a test that found one of
// those would be reaching into their home and reporting on what is in it.
const home = join(dir, 'home');
const work = join(dir, 'work');
for (const path of [home, work, join(home, 'Downloads'), join(work, 'deep', 'nested')]) {
  mkdirSync(path, { recursive: true });
}

const env = {
  ...process.env,
  HOME: home,
  XDG_RUNTIME_DIR: join(dir, 'run'),
  XDG_STATE_HOME: join(dir, 'state'),
  CLIO_DEV: '1',
};
const HANDSHAKE = join(dir, 'run', 'clio', 'daemon.json');
const DROPS = join(dir, 'state', 'clio', 'drops');

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

/** Wait for something to become true, rather than for a length of time. */
async function until(condition, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await sleep(100);
  }
  return false;
}

/** A file on disk, with a modification time this test chose. */
function put(path, contents, mtime = 1700000000000) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  utimesSync(path, new Date(mtime), new Date(mtime));
  return path;
}

/** A file described the way a drag describes it to the page. */
function asDropped(path, dir = false) {
  const st = statSync(path);
  return { name: basename(path), size: st.size, mtime: Math.floor(st.mtimeMs), dir };
}

// ---- the files this test drops ------------------------------------------

const note = put(join(work, 'note.txt'), 'a note in the working directory');
const nested = put(join(work, 'deep', 'nested', 'buried.txt'), 'further down');
const download = put(join(home, 'Downloads', 'photo of me.png'), 'pretend png');
const folder = join(work, 'deep');

// Same name, different file: dropping one of these must not type the path of
// the other.
put(join(work, 'twin.txt'), 'the twin in the working directory');
const otherTwin = put(join(home, 'Downloads', 'twin.txt'), 'a different twin, of a different size');

async function main() {
  execFileSync(CLIO, ['start'], { env, stdio: 'ignore' });
  await sleep(600);
  const info = JSON.parse(readFileSync(HANDSHAKE, 'utf8'));
  const origin = `http://127.0.0.1:${info.port}`;
  console.log(`sandbox daemon on port ${info.port}, home at ${home}\n`);

  const container = randomBytes(4).toString('hex');
  const ws = new WebSocket(`ws://127.0.0.1:${info.port}/?token=${info.token}&c=${container}`, {
    origin,
  });
  const messages = [];
  ws.on('message', (raw) => messages.push(JSON.parse(raw)));
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  const waitFor = async (predicate, timeout = 4000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const found = messages.find(predicate);
      if (found) return found;
      await sleep(30);
    }
    return null;
  };

  // A tab in the working directory, which is where locate() looks first.
  ws.send(JSON.stringify({ t: 'create', cwd: work, cols: 80, rows: 24 }));
  const created = await waitFor((m) => m.t === 'created');
  if (!created) throw new Error('the daemon never made a tab');
  const id = created.id;

  /**
   * Drop files on the tab and wait for the line it produces.
   *
   * `bytes` stands in for the window reading the file: a Buffer for an index the
   * daemon asks about, null to answer that it could not be read.
   */
  const drop = async (items, bytes = {}) => {
    const token = `t${messages.length}-${randomBytes(3).toString('hex')}`;
    const before = messages.length;
    ws.send(JSON.stringify({ t: 'drop', id, drop: token, files: items }));

    const need = await waitFor((m) => m.t === 'dropneed' && m.drop === token, 1500);
    if (need) {
      for (const index of need.need) {
        const buffer = bytes[index];
        ws.send(
          JSON.stringify(
            buffer
              ? { t: 'dropdata', drop: token, index, data: buffer.toString('base64') }
              : { t: 'dropdata', drop: token, index, error: 'unreadable' },
          ),
        );
      }
    }

    const text = await waitFor((m) => m.t === 'droptext' && m.drop === token);
    return { ...(text || {}), asked: need ? need.need : [], since: messages.slice(before) };
  };

  console.log('1. a file that is already on disk keeps its own path');
  {
    const result = await drop([asDropped(note)]);
    check('the real path is typed', result.text === `${note} `, result.text);
    check('and its bytes were never asked for', result.asked.length === 0);
    check('nothing was copied', !existsSync(join(DROPS, 'note.txt')));
  }
  {
    const result = await drop([asDropped(nested)]);
    check('a file further down the tree is found too', result.text === `${nested} `, result.text);
  }
  {
    // ~/Downloads, which is where a file being dragged into a terminal most
    // often comes from, and a name that a shell would otherwise split in two.
    const result = await drop([asDropped(download)]);
    check(
      'a file in ~/Downloads is found',
      result.text === `'${download}' `,
      result.text,
    );
    check('and a space in the name is quoted', result.text.startsWith("'/"));
  }
  {
    const result = await drop([asDropped(folder, true)]);
    check('a folder resolves to its own path', result.text === `${folder} `, result.text);
  }

  console.log('\n2. the same name is not the same file');
  {
    // The one in ~/Downloads was dropped; the one in the working directory has
    // the same name and is searched first. Size and modification time are what
    // keep them apart.
    const result = await drop([asDropped(otherTwin)]);
    check('the file that was dropped is the one typed', result.text === `${otherTwin} `, result.text);
  }
  {
    // Same name and same size as note.txt, but written a day later: not that
    // file, and not to be typed as though it were.
    const impostor = { ...asDropped(note), mtime: Math.floor(statSync(note).mtimeMs) + 86400000 };
    const result = await drop([impostor], { 0: Buffer.from('brought with it') });
    check('a file that only shares a name is copied instead', result.text.startsWith(DROPS), result.text);
    check('and the copy holds what was dropped', readFileSync(result.text.trim(), 'utf8') === 'brought with it');
  }

  console.log('\n3. a file that is nowhere is copied, once');
  {
    const item = { name: 'screenshot.png', size: 11, mtime: 1700000000000 };
    const first = await drop([item], { 0: Buffer.from('pretend png') });
    check('the drop asked for the bytes', first.asked.length === 1);
    check('and typed a path in the drops directory', first.text.startsWith(join(DROPS, 'screenshot.png')), first.text);

    const again = await drop([item], { 0: Buffer.from('pretend png') });
    check('dropping the same file again reuses the copy', again.text === first.text, again.text);

    const different = await drop([{ ...item, size: 9 }], { 0: Buffer.from('different') });
    check(
      'a different file of the same name gets its own',
      different.text.trim() !== first.text.trim() && different.text.startsWith(DROPS),
      different.text,
    );
    check(
      'and does not overwrite the first',
      readFileSync(first.text.trim(), 'utf8') === 'pretend png',
    );
  }

  console.log('\n4. what the window says is not to be trusted');
  {
    const result = await drop([{ name: '../../../escape.txt', size: 3, mtime: 1700000000000 }], {
      0: Buffer.from('no!'),
    });
    check('a name that climbs out of the directory does not', dirname(result.text.trim()) === DROPS, result.text);
    check('and nothing was written above it', !existsSync(join(dir, 'state', 'escape.txt')));
  }
  {
    const result = await drop([{ name: 'huge.iso', size: 60 * 1024 * 1024, mtime: 1700000000000 }]);
    check('a file too big to copy is not asked for', result.asked.length === 0);
    check('nothing is typed', result.text === '', result.text);
    check('and the window is told why', /too big/.test(result.note || ''), result.note || 'no note');
  }
  {
    const result = await drop([{ name: 'elsewhere', size: 4096, mtime: 1700000000000, dir: true }]);
    check('a folder that is not on this machine is refused', result.text === '');
    check('and the window is told why', /folder/.test(result.note || ''), result.note || 'no note');
  }
  {
    const result = await drop([asDropped(note), { name: 'unreadable.txt', size: 5, mtime: 1 }], { 1: null });
    check('one file failing does not lose the others', result.text === `${note} `, result.text);
    check('and it is mentioned', /could not read/.test(result.note || ''), result.note || 'no note');
  }

  console.log('\n5. several files at once');
  {
    const result = await drop([asDropped(note), asDropped(download)]);
    check(
      'both paths arrive as one line',
      result.text === `${note} '${download}' `,
      result.text,
    );
  }

  console.log('\n6. a drop for somebody else\'s tab');
  {
    const token = 'not-mine';
    const before = messages.length;
    ws.send(
      JSON.stringify({
        t: 'drop',
        id: 'no-such-session',
        drop: token,
        files: [{ name: 'x.txt', size: 1, mtime: 1 }],
      }),
    );
    await sleep(500);
    check(
      'is ignored',
      !messages.slice(before).some((m) => m.t === 'dropneed' || m.t === 'droptext'),
    );
  }

  ws.send(JSON.stringify({ t: 'close', id }));
  ws.close();

  // ---- and now the half that only exists in a browser --------------------

  console.log('\n7. dropping on a real window');
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1100, height: 700 } });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (msg) => msg.type() === 'error' && consoleErrors.push(msg.text()));
  page.on('pageerror', (err) => consoleErrors.push(String(err)));

  const windowContainer = randomBytes(4).toString('hex');
  await page.goto(`${origin}/?token=${info.token}&c=${windowContainer}`);
  await page.waitForSelector('.xterm-screen', { timeout: 10000 });
  await page.waitForTimeout(1500);

  /** A drag carrying one file, as the browser would hand it to the page. */
  const dragging = (name, contents, mtime) =>
    page.evaluateHandle(
      ([fileName, text, time]) => {
        const transfer = new DataTransfer();
        transfer.items.add(new File([text], fileName, { lastModified: time }));
        return transfer;
      },
      [name, contents, mtime],
    );

  // Held over the window but not yet let go: the pane says where it would land.
  const hovering = await dragging('note.txt', 'x', 1700000000000);
  await page.dispatchEvent('.xterm-screen', 'dragover', { dataTransfer: hovering });
  check('the pane it would land in is outlined', (await page.locator('.pane.dropping').count()) === 1);
  await page.dispatchEvent('body', 'dragleave', { dataTransfer: hovering, relatedTarget: null });
  check('and lets go of it again', (await page.locator('.pane.dropping').count()) === 0);

  /**
   * Drop a file into a tab and read back exactly what the shell received.
   *
   * `cat` rather than a prompt, because a prompt would echo and wrap and leave
   * this asserting on what the screen looks like. The file it writes is what
   * came down the pty, character for character.
   */
  const droppedInto = async (name, contents, mtime) => {
    const out = join(dir, `typed-${randomBytes(3).toString('hex')}.txt`);
    await page.locator('.xterm-screen').first().click();
    await page.keyboard.type(`cd ${work} && cat > ${out}\n`);
    // The redirect creates that file the moment the shell runs the line, which
    // is also the moment the tab is in `work` — where the dropped file is.
    // Waiting for it beats guessing how long a busy machine takes to get there,
    // and guessing is how this came to pass on an idle one and fail on a loaded
    // one.
    if (!(await until(() => existsSync(out)))) return '(the shell never ran the command)';

    const transfer = await dragging(name, contents, mtime);
    await page.dispatchEvent('.xterm-screen', 'drop', { dataTransfer: transfer });
    // The daemon has to look for the file, and may have to be sent it, before
    // anything is typed. What arrives is echoed by the tty; the name is in it
    // whichever path won.
    const screen = () => page.locator('.pane.active .xterm-rows').first().innerText();
    if (!(await until(async () => (await screen()).replace(/\n/g, '').includes(name)))) {
      return '(nothing was typed)';
    }

    await page.keyboard.press('Enter');
    await page.keyboard.press('Control+d');
    await until(() => existsSync(out) && readFileSync(out, 'utf8').length > 0);
    return existsSync(out) ? readFileSync(out, 'utf8') : '';
  };

  {
    const typed = await droppedInto('note.txt', 'a note in the working directory', 1700000000000);
    check('the file the person can see is the path that is typed', typed.includes(note), JSON.stringify(typed));
    check('and nothing was copied to say it with', !typed.includes(DROPS), JSON.stringify(typed));
  }
  {
    // Nothing on this disk looks like this, so the bytes have to travel.
    const typed = await droppedInto('from-the-browser.png', 'pretend png bytes', 1500000000000);
    const path = typed.trim();
    check('a file with no path on disk becomes one', path.startsWith(DROPS), JSON.stringify(typed));
    check(
      'and the bytes are all there',
      existsSync(path) && readFileSync(path, 'utf8') === 'pretend png bytes',
      path,
    );
  }

  check('no console errors', consoleErrors.length === 0, consoleErrors[0]);
  await browser.close();
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
