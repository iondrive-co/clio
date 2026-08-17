/*
 * Real-browser UI test.
 *
 * The point of this file is to exercise clio the way a person does: a real
 * Chromium window, real mouse clicks at real coordinates, real key presses, and
 * screenshots that get looked at. The earlier tests drove the app by calling
 * its own functions, which passed happily while the actual window was unusable.
 *
 * It starts a daemon of its own, on its own state, and takes it down again:
 *
 *   node test/ui.mjs
 */
import { chromium } from 'playwright';
import { readFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { execSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';

// Most of this file is headless, but one section asks the daemon for a real
// browser window. That window must never land on the desktop of whoever is
// running the tests: it steals their focus, and a window a person is clicking
// on or closing does not behave the way the assertions expect — failures that
// look for all the world like bugs in clio.
//
// Dropped here, before anything can inherit it, and handed back only as a
// display this file started for itself. See startDisplay below.
delete process.env.DISPLAY;
delete process.env.WAYLAND_DISPLAY;

// And a clio of this run's own, from the first line to the last.
//
// Section 16 SIGKILLs the daemon and starts it again through the launcher —
// which is the whole point of that section, and is fatal to whoever's shells
// the daemon happens to be holding: their processes die with it, and their tabs
// come back around new ones with the work in them gone. Which daemon that is
// was, until this line existed, whichever one the caller's environment pointed
// at. Inheriting a real XDG_RUNTIME_DIR meant a test run reaching into somebody
// working two windows away, and no amount of care further down this file could
// have stopped it.
//
// So the sandbox is made here, before HANDSHAKE below is worked out from it,
// and every `bin/clio` this file runs inherits it. Do not make these
// conditional, and do not add a way to point this at a daemon it did not start.
const SANDBOX = mkdtempSync(join(tmpdir(), 'clio-ui-'));
process.env.XDG_RUNTIME_DIR = join(SANDBOX, 'run');
process.env.XDG_STATE_HOME = join(SANDBOX, 'state');
mkdirSync(process.env.XDG_RUNTIME_DIR, { recursive: true });
mkdirSync(process.env.XDG_STATE_HOME, { recursive: true });
// Says "sandbox" in the window title, and is what the daemon reads to know it
// is one — the dev badge, the UI watcher, and section 17 below all hang off it.
process.env.CLIO_DEV = '1';

const HANDSHAKE = join(process.env.XDG_RUNTIME_DIR, 'clio', 'daemon.json');
const SHOTS = join(process.cwd(), 'test', 'screenshots');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// wmctrl is not involved here, but a browser window with no window manager has
// nothing to give it a frame or a close button, so keep the same requirement.
const WINDOW_MANAGERS = ['openbox', 'xfwm4', 'marco', 'icewm', 'fluxbox', 'jwm', 'metacity'];

function installed(command) {
  try {
    execSync(`command -v ${command}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const displayProcesses = [];

function stopDisplay() {
  while (displayProcesses.length) {
    try {
      displayProcesses.pop().kill();
    } catch {
      /* already gone */
    }
  }
}

// However this run ends — a passing exit, a failed assertion, a throw — the
// display goes with it rather than being left on the machine, and so do the
// daemon and the shells this run started. Both are synchronous on purpose: an
// exit handler is the last moment anything runs.
process.on('exit', () => {
  stopDisplay();
  try {
    execSync('./bin/clio stop', { stdio: 'ignore' });
  } catch {
    /* it never started, or it is already down */
  }
  try {
    rmSync(SANDBOX, { recursive: true, force: true });
  } catch {
    /* leave it, it is in /tmp */
  }
});

/**
 * A display of this test's own making, or null if the machine cannot provide
 * one. Null means the window section is skipped: using the display that is
 * already there is not an alternative.
 */
async function startDisplay() {
  if (!installed('Xvfb')) return null;
  const wm = WINDOW_MANAGERS.find(installed);
  if (!wm) return null;

  for (let n = 91; n < 120; n++) {
    if (existsSync(`/tmp/.X${n}-lock`)) continue;
    const display = `:${n}`;

    const xvfb = spawn('Xvfb', [display, '-screen', '0', '1280x900x24'], { stdio: 'ignore' });
    displayProcesses.push(xvfb);
    await sleep(1500);
    if (xvfb.exitCode !== null) continue; // that number was taken after all

    displayProcesses.push(
      spawn(wm, [], { stdio: 'ignore', env: { ...process.env, DISPLAY: display } }),
    );
    await sleep(1500);
    return display;
  }
  return null;
}

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

// ---------------------------------------------------------------- contrast

function srgbToLinear(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function luminance([r, g, b]) {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

function contrast(fg, bg) {
  const a = luminance(fg);
  const b = luminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

function parseColor(str) {
  const m = str.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const parts = m[1].split(',').map((p) => parseFloat(p.trim()));
  return [parts[0], parts[1], parts[2]];
}

/**
 * Check every visible piece of text on screen, not a hand-picked few.
 *
 * Picking selectors by hand only ever tests the places you already thought
 * about — it is how an accent-blue command label on an accent-blue button
 * shipped completely invisible. Terminal content is excluded: its colours come
 * from the palette check and xterm's own minimumContrastRatio.
 */
async function sweepContrast(page, label) {
  const samples = await page.evaluate(() => {
    const bgOf = (node) => {
      let el = node;
      while (el) {
        const style = getComputedStyle(el);
        const c = style.backgroundColor;
        if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') {
          const alpha = c.startsWith('rgba') ? parseFloat(c.split(',')[3]) : 1;
          if (alpha > 0.5) return c;
        }
        el = el.parentElement;
      }
      return getComputedStyle(document.body).backgroundColor;
    };

    const describe = (el) => {
      const id = el.id ? `#${el.id}` : '';
      const cls = typeof el.className === 'string' && el.className
        ? `.${el.className.trim().split(/\s+/).join('.')}`
        : '';
      return `${el.tagName.toLowerCase()}${id}${cls}`;
    };

    const out = [];
    for (const el of document.querySelectorAll('body *')) {
      if (el.closest('.xterm')) continue; // terminal content, covered elsewhere
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      if (parseFloat(style.opacity) < 0.9) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;

      // only elements holding their own text, so we do not score containers
      const ownText = [...el.childNodes]
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent.trim())
        .join('');
      if (!ownText) continue;

      out.push({
        what: describe(el),
        text: ownText.slice(0, 24),
        fg: style.color,
        bg: bgOf(el),
        size: parseFloat(style.fontSize),
        weight: style.fontWeight,
      });
    }
    return out;
  });

  let worst = null;
  for (const s of samples) {
    const fg = parseColor(s.fg);
    const bg = parseColor(s.bg);
    if (!fg || !bg) continue;
    const ratio = contrast(fg, bg);
    // WCAG: 3:1 counts for large text (>=18.66px, or >=24px at normal weight)
    const large = s.size >= 24 || (s.size >= 18.66 && Number(s.weight) >= 700);
    const floor = large ? 3 : 4.5;
    const ok = ratio >= floor;
    if (!ok || !worst || ratio < worst.ratio) worst = { ...s, ratio, floor, ok };
    check(
      `[${label}] ${s.what} "${s.text}" ${ratio.toFixed(2)}:1`,
      ok,
      `${s.fg} on ${s.bg}, needs ${floor}:1`,
    );
  }
  if (!samples.length) check(`[${label}] found text to measure`, false);
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  console.log(`sandbox at ${SANDBOX}\n`);
  // The sandbox has no daemon in it yet; this is the first thing that ever
  // runs there. Through the launcher, because that is what section 16 does too.
  execSync('./bin/clio start', { stdio: 'ignore' });
  const info = JSON.parse(readFileSync(HANDSHAKE, 'utf8'));
  const origin = `http://127.0.0.1:${info.port}`;

  /** Live view of the daemon's windows and their tabs. */
  const daemonStatus = async () =>
    (await fetch(`${origin}/status?token=${info.token}`, { cache: 'no-store' })).json();

  /** Another window onto a container, for driving one this page cannot touch. */
  const windowOnto = (container) =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${info.port}/?token=${info.token}&c=${container}`, {
        origin,
      });
      ws.on('error', reject);
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (msg.t === 'sessions') resolve({ ws, tabs: msg.sessions });
      });
    });

  // This run gets a window of its own. Sharing one with whatever the machine
  // already has open would mean a test that closes tabs closing somebody's
  // work, and assertions that depend on what was there before it started.
  const testWindow = randomBytes(4).toString('hex');

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1100, height: 700 } });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));

  // Nothing should ever ask about leaving: closing a window puts its tabs away
  // rather than ending them, so there is nothing to warn about. Anything that
  // does appear is accepted, and counted — a dialog here means the guard came
  // back, and a browser dialog in the way is how a person ends up closing a
  // window twice.
  let closeDialogs = 0;
  page.on('dialog', async (dialog) => {
    if (dialog.type() === 'beforeunload') closeDialogs++;
    await dialog.accept();
  });

  // ---- load exactly like the launcher does ------------------------------
  console.log('1. first load');
  await page.goto(`${origin}/?token=${info.token}&c=${testWindow}`);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: join(SHOTS, '01-first-load.png') });

  check('no dead screen', await page.locator('#deadscreen').isHidden());
  check('a tab is present', (await page.locator('.tab').count()) >= 1);
  // The token is scrubbed from the address bar; which window this is must not
  // be, or a reload comes back showing another window's tabs.
  check(
    'the window keeps its own name in the URL',
    (await page.evaluate(() => location.search)) === `?c=${testWindow}`,
    await page.evaluate(() => location.search),
  );
  check('terminal rendered', await page.locator('.xterm-screen').isVisible());
  check('no console errors', consoleErrors.length === 0, consoleErrors[0]);

  // ---- real mouse click on the + button ---------------------------------
  console.log('\n2. clicking + with a real mouse');
  const before = await page.locator('.tab').count();
  await page.locator('#newtab').click(); // real pointer event, hit-tested
  await page.waitForTimeout(1200);
  const after = await page.locator('.tab').count();
  check('+ opened a tab', after === before + 1, `${before} -> ${after}`);

  await page.locator('#newtab').click();
  await page.waitForTimeout(1200);
  check('+ opened another tab', (await page.locator('.tab').count()) === before + 2);

  // ---- real typing into the shell ---------------------------------------
  console.log('\n3. typing for real');
  await page.locator('.pane.active .xterm-screen').click();
  await page.keyboard.type('echo real-keyboard-$((3*14))');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
  const screenText = await page.locator('.pane.active').innerText();
  check('typed command produced output', screenText.includes('real-keyboard-42'));
  await page.screenshot({ path: join(SHOTS, '02-after-typing.png') });

  // ---- contrast of every piece of chrome text ---------------------------
  console.log('\n4. contrast (WCAG AA needs 4.5:1 for body text)');
  await sweepContrast(page, 'first load');

  // ---- terminal palette fidelity ----------------------------------------
  //
  // Held against xfce4-terminal's defaults rather than a contrast floor. A
  // floor is the wrong test for terminal content: this palette cannot clear
  // 4.5:1 on black and is not supposed to, and every earlier attempt to make it
  // do so desaturated it into something that read as washed out. Chrome text is
  // still swept for WCAG in step 4 — that part clio controls, and a label it
  // renders itself has no program to be faithful to.
  console.log('\n5. terminal palette matches xfce4-terminal');
  const XFCE_DEFAULT = {
    background: '#000000',
    foreground: '#ffffff',
    black: '#000000',
    red: '#aa0000',
    green: '#00aa00',
    yellow: '#aa5500',
    blue: '#0000aa',
    magenta: '#aa00aa',
    cyan: '#00aaaa',
    white: '#aaaaaa',
    brightBlack: '#555555',
    brightRed: '#ff5555',
    brightGreen: '#55ff55',
    brightYellow: '#ffff55',
    brightBlue: '#5555ff',
    brightMagenta: '#ff55ff',
    brightCyan: '#55ffff',
    brightWhite: '#ffffff',
  };
  const palette = await page.evaluate(() => {
    const t = panes.get(activeId).term.options.theme;
    return Object.fromEntries(Object.entries(t).filter(([, v]) => typeof v === 'string'));
  });
  for (const [name, want] of Object.entries(XFCE_DEFAULT)) {
    check(`${name} is ${want}`, palette[name] === want, `got ${palette[name]}`);
  }

  // The other half of looking right. Above 1, xterm steps any under-contrast
  // foreground 10% toward white per pass until it clears, which is what turned
  // statuslines and fzf highlights into flat white and #aa0000 into #cf6a6a.
  check(
    'no render-time colour adjustment',
    (await page.evaluate(() => panes.get(activeId).term.options.minimumContrastRatio)) === 1,
    'anything above 1 blends colours toward white',
  );

  // ---- reload must not break the window ---------------------------------
  console.log('\n6. reload');
  await page.reload();
  await page.waitForTimeout(2500);
  // Nothing is lost by leaving, so nothing asks about it.
  check('leaving the page asked nothing', closeDialogs === 0, `${closeDialogs} dialogs`);
  check('still no dead screen after reload', await page.locator('#deadscreen').isHidden());
  const reloadTabs = await page.locator('.tab').count();
  check('tabs came back after reload', reloadTabs >= 3, `${reloadTabs} tabs`);
  await page.locator('#newtab').click();
  await page.waitForTimeout(1200);
  check('+ still works after reload', (await page.locator('.tab').count()) === reloadTabs + 1);
  await page.screenshot({ path: join(SHOTS, '03-after-reload.png') });

  // ---- right-click menu with a real right button -------------------------
  console.log('\n7. right-click menu');
  await page.locator('.pane.active .xterm-screen').click({ button: 'right' });
  await page.waitForTimeout(400);
  check('menu opened on right-click', await page.locator('#ctxmenu').isVisible());
  await page.screenshot({ path: join(SHOTS, '04-context-menu.png') });
  const menuItems = await page.locator('#ctxmenu .item').allInnerTexts();
  check('menu has entries', menuItems.length === 7, menuItems.join(' | '));
  check(
    'menu offers to close the other tabs',
    menuItems.some((t) => t.startsWith('Close Other Tab')),
    menuItems.join(' | '),
  );
  await sweepContrast(page, 'context menu');
  await page.keyboard.press('Escape');
  await page.mouse.click(550, 400);
  await page.waitForTimeout(300);

  // ---- naming this window -------------------------------------------------
  //
  // The name is what the tabs are put away under when the window is closed, and
  // what the picker lists them by. Given here, before it is needed, it is the
  // difference between finding a window again and reading a list of
  // directories.
  console.log('\n7b. naming this window');
  const naming = page.locator('#ctxmenu .item', { hasText: 'Name This Window' });

  await page.locator('.pane.active .xterm-screen').click({ button: 'right' });
  await page.waitForTimeout(400);
  check('the menu offers to name the window', (await naming.count()) === 1);

  await naming.click();
  await page.waitForTimeout(300);
  const nameField = page.locator('#ctxmenu .item.field input');
  check('choosing it opens a field to type in', await nameField.isVisible());
  await nameField.fill('the window under test');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
  check('the menu closes on Enter', await page.locator('#ctxmenu').isHidden());
  check(
    'the name reached the daemon',
    (await daemonStatus()).containers.find((c) => c.id === testWindow)?.name ===
      'the window under test',
  );
  check(
    'and the window says so in its title',
    (await page.title()).includes('the window under test'),
    await page.title(),
  );

  // ---- the picker --------------------------------------------------------
  //
  // The whole point of closing a window being survivable: the tabs are put away
  // under a name, and a window that opens while any are waiting opens onto the
  // list of them instead of a blank shell.
  console.log('\n7c. a closed window comes back from the picker');
  const parked = randomBytes(4).toString('hex');
  const away = await windowOnto(parked);
  away.ws.send(JSON.stringify({ t: 'create', cwd: '/tmp', cols: 80, rows: 24 }));
  await sleep(1200);
  away.ws.send(JSON.stringify({ t: 'renamewindow', name: 'parked for the picker' }));
  await sleep(600);
  away.ws.close();
  // Past the grace period the daemon allows for a page that is only reloading.
  await sleep(13000);

  const beforePick = (await daemonStatus()).containers.find((c) => c.id === parked);
  check('the closed window is being kept', !!beforePick?.saved);

  const chooser = await context.newPage();
  chooser.on('pageerror', (err) => consoleErrors.push(`picker: ${err}`));
  await chooser.goto(
    `${origin}/?token=${info.token}&c=${randomBytes(4).toString('hex')}&pick=1`,
  );
  await chooser.waitForTimeout(2000);
  check('a window opened with pick=1 shows the picker', await chooser.locator('#picker').isVisible());
  await chooser.screenshot({ path: join(SHOTS, '04b-picker.png') });
  await sweepContrast(chooser, 'window picker');

  const offered = await chooser.locator('#picker .group-name').allInnerTexts();
  check('it lists the window that was closed, by name', offered.includes('parked for the picker'),
    offered.join(' | '));

  await chooser.locator('#picker .group-open', { hasText: 'parked for the picker' }).click();
  await chooser.waitForTimeout(2500);
  check('choosing it puts the picker away', await chooser.locator('#picker').isHidden());
  check('and the tabs are on screen', (await chooser.locator('.tab').count()) === 1,
    `${await chooser.locator('.tab').count()} tabs`);
  check(
    'the daemon counts it as open again, not as one still waiting',
    (await daemonStatus()).containers.find((c) => c.id === parked)?.saved === false,
  );
  check(
    'and the window it opened on is not left behind as an empty one',
    (await daemonStatus()).containers.every((c) => c.sessions.length > 0),
  );

  // Leave nothing running: these shells outlive the browser by design, and a
  // window left waiting here changes what every later test sees.
  //
  // The page goes first and the tabs are closed from outside it. Done the other
  // way round, a window whose last tab closes tries to close itself, and a page
  // the browser will not close for a script opens a fresh shell rather than sit
  // there dead — leaving exactly the window this is trying to clear up.
  await chooser.close();
  await sleep(1500);
  const { ws: tidy, tabs: tidyTabs } = await windowOnto(parked);
  for (const tab of tidyTabs) tidy.send(JSON.stringify({ t: 'close', id: tab.id }));
  await sleep(1000);
  tidy.close();
  check(
    'and nothing is left waiting once its tabs are closed',
    !(await daemonStatus()).containers.some((c) => c.id === parked),
  );

  // ---- closing tabs ------------------------------------------------------
  console.log('\n8. closing tabs');
  const n = await page.locator('.tab').count();
  await page.locator('.tab').first().hover();
  await page.locator('.tab').first().locator('.tab-close').click();
  await page.waitForTimeout(1000);
  check('close button removed a tab', (await page.locator('.tab').count()) === n - 1);

  // ---- real keyboard shortcuts ------------------------------------------
  console.log('\n9. keyboard shortcuts');
  await page.locator('.pane.active .xterm-screen').click();
  const beforeKeys = await page.locator('.tab').count();
  await page.keyboard.press('Control+Shift+T');
  await page.waitForTimeout(1200);
  check('Ctrl+Shift+T opened a tab', (await page.locator('.tab').count()) === beforeKeys + 1);

  await page.keyboard.press('Alt+1');
  await page.waitForTimeout(400);
  check(
    'Alt+1 selects the first tab',
    await page.locator('.tab').first().evaluate((e) => e.classList.contains('active')),
  );

  // Ctrl+C must reach the shell rather than being eaten as a shortcut
  await page.locator('.pane.active .xterm-screen').click();
  await page.keyboard.type('sleep 30');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(900);
  await page.keyboard.press('Control+C');
  await page.waitForTimeout(900);
  await page.keyboard.type('echo interrupted-ok');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);
  check(
    'Ctrl+C reached the shell and cancelled the job',
    (await page.locator('.pane.active').innerText()).includes('interrupted-ok'),
  );

  // ---- rename by double-clicking, typing for real -------------------------
  console.log('\n10. rename');
  const renameTarget = page.locator('.tab').first();
  await renameTarget.dblclick();
  await page.waitForTimeout(300);
  const renameInput = renameTarget.locator('input');
  check('double-click opened an input', await renameInput.isVisible());
  await renameInput.fill('renamed-for-real');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(900);
  check(
    'the new name stuck',
    (await page.locator('.tab').first().innerText()).includes('renamed-for-real'),
  );

  // it must survive a reload, i.e. it reached the daemon
  await page.reload();
  await page.waitForTimeout(2500);
  check(
    'the name survived a reload (so the daemon stored it)',
    (await page.locator('.tab-title').allInnerTexts()).some((t) => t.includes('renamed-for-real')),
  );

  // ---- drag to reorder with a real mouse ---------------------------------
  console.log('\n11. drag to reorder');
  const labelsBefore = await page.locator('.tab-title').allInnerTexts();
  await page.locator('.tab').first().dragTo(page.locator('.tab').nth(2));
  await page.waitForTimeout(900);
  const labelsAfter = await page.locator('.tab-title').allInnerTexts();
  check('order changed after the drag', JSON.stringify(labelsBefore) !== JSON.stringify(labelsAfter),
    labelsAfter.join(' | '));
  check(
    'the same tabs are all still there',
    JSON.stringify([...labelsBefore].sort()) === JSON.stringify([...labelsAfter].sort()),
  );

  await page.screenshot({ path: join(SHOTS, '05-final.png') });
  check('no console errors overall', consoleErrors.length === 0, consoleErrors.join(' | '));

  // ---- font matches xfce4-terminal ---------------------------------------
  console.log('\n12. font');
  const font = await page.evaluate(() => {
    const t = panes.get(activeId).term.options;
    return { family: t.fontFamily, size: t.fontSize };
  });
  check('font size matches Liberation Mono 11pt at 96dpi', Math.abs(font.size - 14.667) < 0.01,
    `${font.size}px`);
  check('uses Liberation Mono first', font.family.startsWith('"Liberation Mono"'), font.family);
  const cellWidth = await page.evaluate(
    () => document.querySelector('.xterm-cursor-layer, .xterm-rows')?.getBoundingClientRect().width,
  );
  check('terminal actually laid out at that size', cellWidth > 0);

  // ---- font size arrows ---------------------------------------------------
  console.log('\n12b. font size arrows');
  const termSizes = () => page.evaluate(() =>
    [...panes.values()].map((p) => p.term.options.fontSize));
  const headerSize = () => page.evaluate(() =>
    parseFloat(getComputedStyle(document.querySelector('.tab-title')).fontSize));

  // Terminals are built lazily on first view, so visit a couple of tabs to
  // materialise them — a size change has to reach every one that exists, not
  // just the one on screen.
  if ((await page.locator('.tab').count()) >= 2) {
    await page.locator('.tab').nth(0).click();
    await page.waitForTimeout(800);
    await page.locator('.tab').nth(1).click();
    await page.waitForTimeout(800);
  }

  const startSizes = await termSizes();
  const startHeader = await headerSize();
  check('arrows are on the right of the tab row', await page.evaluate(() => {
    const box = document.getElementById('fontsize').getBoundingClientRect();
    const tabs = document.getElementById('tabs').getBoundingClientRect();
    return box.left >= tabs.right - 1 && box.right <= window.innerWidth + 1;
  }));

  await page.locator('#font-up').click();
  await page.waitForTimeout(600);
  const bigger = await termSizes();
  check('up arrow grows the text', bigger[0] > startSizes[0], `${startSizes[0]} -> ${bigger[0]}`);
  check('every tab changed, not just the visible one',
    bigger.length > 1 && bigger.every((s) => s === bigger[0]), JSON.stringify(bigger));
  check('the pty was resized to match', await page.evaluate(async () => {
    const p = panes.get(activeId);
    return p.term.cols > 0 && p.term.rows > 0;
  }));

  await page.locator('#font-up').click();
  await page.locator('#font-up').click();
  await page.waitForTimeout(600);
  const evenBigger = await termSizes();
  check('it keeps growing', evenBigger[0] === bigger[0] + 2, `${evenBigger[0]}`);

  await page.locator('#font-down').click();
  await page.waitForTimeout(600);
  check('down arrow shrinks it', (await termSizes())[0] === evenBigger[0] - 1);

  check('tab headers are untouched', (await headerSize()) === startHeader,
    `${startHeader} -> ${await headerSize()}`);

  // A tab opened afterwards must come up at the chosen size, not the default.
  const sizeNow = (await termSizes())[0];
  await page.locator('#newtab').click();
  await page.waitForTimeout(1400);
  const withNewTab = await termSizes();
  check('a tab opened afterwards uses the chosen size',
    withNewTab.every((s) => s === sizeNow), JSON.stringify(withNewTab));

  // the terminal must still work at the new size
  await page.locator('.pane.active .xterm-screen').click();
  await page.keyboard.type('echo resized-and-usable');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);
  check('shell still usable after resizing',
    (await page.locator('.pane.active').innerText()).includes('resized-and-usable'));
  await page.screenshot({ path: join(SHOTS, '10-font-larger.png') });

  const chosen = (await termSizes())[0];
  await page.reload();
  await page.waitForTimeout(2500);
  check('the size is remembered across a reload', (await termSizes())[0] === chosen,
    `${chosen} -> ${(await termSizes())[0]}`);

  // bounds
  await page.evaluate(() => setFontSize(999));
  await page.waitForTimeout(300);
  const maxed = (await termSizes())[0];
  check('clamped at a sane maximum', maxed <= 40, `${maxed}`);
  check('up arrow disables at the ceiling',
    await page.locator('#font-up').isDisabled());
  await page.evaluate(() => setFontSize(-5));
  await page.waitForTimeout(300);
  check('clamped at a sane minimum', (await termSizes())[0] >= 8);

  await page.evaluate((n) => setFontSize(n), chosen);
  await page.waitForTimeout(400);

  // ---- + button sits beside the last tab ---------------------------------
  console.log('\n13. + button placement');
  const geometry = await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('.tab')];
    const last = tabs[tabs.length - 1].getBoundingClientRect();
    const plus = document.getElementById('newtab').getBoundingClientRect();
    return { lastRight: last.right, plusLeft: plus.left, windowWidth: window.innerWidth };
  });
  check(
    '+ is immediately right of the last tab',
    geometry.plusLeft >= geometry.lastRight && geometry.plusLeft - geometry.lastRight < 24,
    `last ends ${geometry.lastRight}, + starts ${geometry.plusLeft}`,
  );
  check(
    '+ is no longer pinned to the far edge',
    geometry.plusLeft < geometry.windowWidth - 100,
    `+ at ${geometry.plusLeft} of ${geometry.windowWidth}`,
  );

  // ---- the other + : a whole new window ----------------------------------
  //
  // Two buttons that both mean "new" and do very different things, so this
  // checks where it sits and that it looks nothing like the tab one, as well as
  // what it does.
  console.log('\n13b. the new-window button');
  const winButton = await page.evaluate(() => {
    const button = document.getElementById('newwindow').getBoundingClientRect();
    const arrows = document.getElementById('fontsize').getBoundingClientRect();
    const plus = document.getElementById('newtab');
    return {
      rightOfArrows: button.left >= arrows.right - 1,
      onScreen: button.right <= window.innerWidth && button.width > 0 && button.height > 0,
      drawn: !!document.querySelector('#newwindow svg'),
      typed: plus.textContent.trim(),
      says: document.getElementById('newwindow').title,
    };
  });
  check('it is to the right of the font arrows', winButton.rightOfArrows);
  check('and inside the window', winButton.onScreen);
  check('it is drawn, not the same + as the tab button', winButton.drawn && winButton.typed === '+');
  check('it says what it does on hover', winButton.says === 'New window', winButton.says);

  // Everything above is headless; this part is not.
  const display = await startDisplay();
  if (!display) {
    console.log('  - the rest needs Xvfb and a window manager of its own; skipped');
  } else {
    console.log(`  (on ${display}, started for this test and taken down after it)`);

    // Somewhere identifiable, so where the new window starts is provable.
    await page.locator('.pane.active .xterm-screen').click();
    await page.keyboard.type('cd /usr/share');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2600); // the daemon polls /proc every 2s

    // The daemon is what spawns browser windows, and it aims them at whatever
    // display the launcher last handed it — which may be the one this test just
    // disowned. Run the launcher once against ours to point it somewhere safe;
    // that opens a window of its own, which is closed again below.
    const beforeSeed = (await daemonStatus()).containers.map((c) => c.id);
    execSync('./bin/clio', { stdio: 'ignore', env: { ...process.env, DISPLAY: display } });
    await page.waitForTimeout(1500);
    const seeded = (await daemonStatus()).containers
      .map((c) => c.id)
      .filter((id) => !beforeSeed.includes(id));

    const known = (await daemonStatus()).containers.map((c) => c.id);
    const tabsHere = await page.locator('.tab').count();

    // What + does depends on whether anything is waiting: with windows put
    // away it opens onto the picker, so that + is also the way back to one.
    // With nothing waiting — the case here — it is a shell, straight away.
    const waiting = (await daemonStatus()).containers.filter((c) => c.saved);
    check('nothing is waiting, so + means a new shell', waiting.length === 0,
      JSON.stringify(waiting.map((c) => c.name)));

    await page.locator('#newwindow').click();

    // A real browser window has to start and connect, which on a cold profile
    // is not quick. Reporting it as open before it is there is the failure this
    // is looking for, so give it room rather than a fixed sleep.
    let opened = null;
    for (let i = 0; i < 80 && !opened?.onScreen; i++) {
      await page.waitForTimeout(500);
      opened = (await daemonStatus()).containers.find((c) => !known.includes(c.id));
    }

    check('a second window opened', !!opened?.onScreen, JSON.stringify(opened));
    check('it is a window of its own, with one shell in it', opened?.sessions.length === 1,
      JSON.stringify(opened?.sessions));
    check(
      'it starts where the tab it was opened from is',
      opened?.sessions?.[0]?.cwd === '/usr/share',
      opened?.sessions?.[0]?.cwd,
    );
    check(
      'and this window carries on unchanged',
      (await page.locator('.tab').count()) === tabsHere,
      `${tabsHere} tabs before`,
    );

    // Tidy up after ourselves, which is also the last thing worth proving: a
    // window whose final tab closes goes away rather than sitting there empty.
    if (opened) {
      const { ws, tabs } = await windowOnto(opened.id);
      for (const tab of tabs) ws.send(JSON.stringify({ t: 'close', id: tab.id }));
      await page.waitForTimeout(2500);
      ws.close();
      const left = (await daemonStatus()).containers.some((c) => c.id === opened.id);
      check('closing its last tab takes the window with it', !left);
    }

    // And the window the launcher was run for, which was only ever a way to
    // tell the daemon where the desktop is.
    for (const id of seeded) {
      const { ws, tabs } = await windowOnto(id);
      for (const tab of tabs) ws.send(JSON.stringify({ t: 'close', id: tab.id }));
      await page.waitForTimeout(1200);
      ws.close();
    }
    stopDisplay();
  }

  // ---- a program's announced title becomes the tab name -------------------
  console.log('\n14. tab takes its name from the running program');
  // A fresh tab: a title the user set by hand deliberately outranks anything a
  // program announces, so this must not run on the renamed tab from step 10.
  await page.locator('#newtab').click();
  await page.waitForTimeout(1400);
  await page.locator('.pane.active .xterm-screen').click();
  // OSC 2 is what Claude Code uses to publish the current job. It has to stay
  // in the foreground to hold the title, exactly as claude does — a bare printf
  // is overwritten by bash's PROMPT_COMMAND the instant the next prompt draws.
  await page.keyboard.type(
    String.raw`printf '\033]2;Find ineffective agent uses with xenia MCP\007'; sleep 20`,
  );
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1800);
  const activeLabel = await page.locator('.tab.active .tab-title').innerText();
  check('tab shows the announced job name, not the process name',
    activeLabel.includes('Find ineffective agent'), activeLabel);
  check('and not "sleep"', !activeLabel.startsWith('sleep'), activeLabel);
  await page.screenshot({ path: join(SHOTS, '09-job-title.png') });

  // Once it exits, bash resets the title to user@host:path — which tells us
  // nothing the directory does not, so the tab must fall back rather than
  // displaying it.
  await page.keyboard.press('Control+C');
  await page.waitForTimeout(1800);
  const afterShellTitle = await page.locator('.tab.active .tab-title').innerText();
  check('a bare user@host:path title is ignored', !afterShellTitle.includes('@'),
    afterShellTitle);

  // ---- but an ssh tab is named after the host, over the top of that --------
  //
  // The case this is really about: a prompt that announces a bare directory —
  // no user@host: in it, so the rule above does not catch it — and then an ssh
  // away to somewhere else. The title left behind describes a directory on the
  // machine you just left, and it would sit in the tab for the whole session.
  // Which is what it did, until the extension was moved above it.
  //
  // The ssh is real and never reaches the network: ProxyCommand hands it a pipe
  // nothing will ever say hello down, so it waits in the foreground the way a
  // session does. .invalid is nobody's, by RFC 2606.
  console.log('\n14b. an ssh tab is named after its host');
  const SSH_HOST = 'p-fsn-095.test.invalid';
  await page.locator('#newtab').click();
  await page.waitForTimeout(1400);
  await page.locator('.pane.active .xterm-screen').click();
  await page.keyboard.type(
    String.raw`printf '\033]0;~/somewhere\007'; ssh -o "ProxyCommand=sleep 900" -o ControlMaster=no safe@` +
      SSH_HOST,
  );
  await page.keyboard.press('Enter');

  let sshLabel = '';
  for (let i = 0; i < 20 && sshLabel !== SSH_HOST; i++) {
    await page.waitForTimeout(500);
    sshLabel = await page.locator('.tab.active .tab-title').innerText();
  }
  check('the tab shows the host it is on', sshLabel === SSH_HOST, sshLabel);
  check('and not the directory the shell announced on the way past',
    !sshLabel.includes('somewhere'), sshLabel);

  await page.keyboard.press('Control+C');
  await page.waitForTimeout(2500);
  const afterSsh = await page.locator('.tab.active .tab-title').innerText();
  check('leaving the host gives the tab its ordinary name back', afterSsh !== SSH_HOST, afterSsh);

  // ---- activity highlighting ---------------------------------------------
  console.log('\n15. activity in a background tab');
  const watched = await page.evaluate(() => activeId);
  await page.locator('#newtab').click();
  await page.waitForTimeout(1200);

  // make the now-background tab produce output
  await page.evaluate((id) => send({ t: 'input', id, data: 'echo background-noise\r' }), watched);
  await page.waitForTimeout(2000);

  const bgTab = page.locator(`.tab[data-id="${watched}"]`);
  check('background tab is flagged', await bgTab.evaluate((e) => e.classList.contains('activity')));
  const activityColour = await bgTab.locator('.tab-title').evaluate((e) => getComputedStyle(e).color);
  check('its label turns red', activityColour === 'rgb(239, 123, 132)', activityColour);
  await page.screenshot({ path: join(SHOTS, '08-activity.png') });

  check(
    'the tab being watched is not flagged',
    !(await page.locator('.tab.active').evaluate((e) => e.classList.contains('activity'))),
  );

  await bgTab.click();
  await page.waitForTimeout(1500);
  check('looking at it clears the flag',
    !(await bgTab.evaluate((e) => e.classList.contains('activity'))));

  // ---- a repaint clio asked for is not activity ---------------------------
  //
  // A full-screen program draws its whole screen again when the terminal tells
  // it something: the pane lost the keyboard, the pane got it back, the size
  // moved. All three are clio talking to it — nobody typed, nothing happened
  // in that tab — and for a row of agents that is the difference between a red
  // tab meaning "your turn" and meaning nothing at all.
  console.log('\n15b. repaints clio caused itself');
  await page.locator('#newtab').click();
  await page.waitForTimeout(1200);
  const agentTab = await page.evaluate(() => activeId);
  await page.evaluate(
    (fixture) => send({ t: 'input', id: activeId, data: `node ${fixture}\r` }),
    join(process.cwd(), 'test', 'fixtures', 'repaint'),
  );
  await page.waitForTimeout(1500);

  const agentFlagged = () =>
    page.locator(`.tab[data-id="${agentTab}"]`).evaluate((e) => e.classList.contains('activity'));
  check('the tab it is running in starts clean', !(await agentFlagged()));

  // Leaving a tab blurs its pane, and the program answers with a repaint.
  await page.locator(`.tab[data-id="${watched}"]`).click();
  await page.waitForTimeout(1500);
  check('moving to another tab does not flag the one just left', !(await agentFlagged()));

  // A window whose socket dropped — a daemon that crashed, a machine that
  // slept, a screen that locked — comes back to the same tabs and has to say
  // again which one it is showing. If it does not, the daemon counts every tab
  // in the window as unwatched, and the redraw that reattaching provokes lands
  // as unseen activity on the tab the user is looking at.
  await page.locator(`.tab[data-id="${agentTab}"]`).click();
  await page.waitForTimeout(1200);
  await page.evaluate(() => ws.close());
  await page.waitForTimeout(3000);
  check('the tab on screen is not flagged after a reconnect', !(await agentFlagged()));
  check(
    'and the window is working again',
    await page.evaluate(() => ws.readyState === WebSocket.OPEN),
  );

  // The same again as a window that was already open when this was fixed: its
  // page is the old one, it will not say `focus` on the way back, and it
  // cannot be made to without being reloaded out from under whoever is using
  // it. All the daemon gets is the attach, which is only ever sent for the tab
  // going on screen — so that has to be enough on its own.
  await page.evaluate(() => {
    window.beforeTheFix = window.send;
    window.send = (msg) => {
      if (msg.t !== 'focus') window.beforeTheFix(msg);
    };
  });
  await page.evaluate(() => ws.close());
  await page.waitForTimeout(3000);
  check('a window that says nothing but attach is still counted as watching',
    !(await agentFlagged()));
  await page.evaluate(() => {
    window.send = window.beforeTheFix;
  });

  // What must still get through: the program itself saying something.
  await page.locator(`.tab[data-id="${watched}"]`).click();
  await page.waitForTimeout(1200);
  await page.evaluate((id) => send({ t: 'input', id, data: '\r' }), agentTab);
  await page.waitForTimeout(2000);
  check('real output in a background tab is still flagged', await agentFlagged());

  // ---- closing every tab but one -----------------------------------------
  console.log('\n15c. close other tabs');
  while ((await page.locator('.tab').count()) < 3) {
    await page.locator('#newtab').click();
    await page.waitForTimeout(1200);
  }
  const survivor = await page.locator('.tab').first().getAttribute('data-id');

  await page.locator('.tab').first().click({ button: 'right' });
  await page.waitForTimeout(400);
  const othersItem = page.locator('#ctxmenu .item').filter({ hasText: 'Close Other Tab' });
  check('the tab menu offers it', await othersItem.isVisible());
  check('it says how many will go', (await othersItem.innerText()).match(/\(\d+\)/) !== null,
    await othersItem.innerText());

  // Killing several shells at once is not undoable, so it must ask first —
  // and taking it back must leave every one of them running.
  await othersItem.click();
  await page.waitForTimeout(400);
  const confirmItem = page.locator('#ctxmenu .item.danger');
  check('it asks before killing several shells', await confirmItem.isVisible());
  await sweepContrast(page, 'close-others confirmation');
  await page.screenshot({ path: join(SHOTS, '11-close-others-confirm.png') });

  const beforeCancel = await page.locator('.tab').count();
  await page.locator('#ctxmenu .item').filter({ hasText: 'Keep them' }).click();
  await page.waitForTimeout(900);
  check('backing out closes nothing', (await page.locator('.tab').count()) === beforeCancel,
    `${beforeCancel} -> ${await page.locator('.tab').count()}`);

  await page.locator('.tab').first().click({ button: 'right' });
  await page.waitForTimeout(400);
  await page.locator('#ctxmenu .item').filter({ hasText: 'Close Other Tab' }).click();
  await page.waitForTimeout(400);
  await page.locator('#ctxmenu .item.danger').click();
  await page.waitForTimeout(2500);
  const leftOver = await page.locator('.tab').count();
  check('only one tab is left', leftOver === 1, `${leftOver} tabs`);
  check(
    'and it is the one that was right-clicked',
    (await page.locator('.tab').first().getAttribute('data-id')) === survivor,
  );

  await page.locator('.pane.active .xterm-screen').click();
  await page.keyboard.type('echo survivor-still-alive');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
  check(
    'the surviving shell still works',
    (await page.locator('.pane.active').innerText()).includes('survivor-still-alive'),
  );

  // ---- the headline feature, through the real UI --------------------------
  console.log('\n16. surviving a daemon crash');
  await page.locator('.pane.active .xterm-screen').click();
  await page.keyboard.type('cd /etc/apt && sleep 400');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(3000);

  // SIGKILL, so the daemon saves nothing on the way out: the same path as a
  // power cut rather than a clean stop. The restart goes through the launcher
  // rather than by hand, because that is the part that has to work and a
  // substitute for it hid a launcher bug once already.
  process.kill((await daemonStatus()).pid, 'SIGKILL');
  await sleep(1000);
  execSync('./bin/clio start', { stdio: 'ignore' });
  await page.waitForTimeout(9000); // reconnect backoff

  check('window reconnected by itself', await page.locator('#deadscreen').isHidden());

  // Nothing to answer and nothing to click: the tab is simply working again. A
  // pane with no shell behind it swallows everything typed into it, so asking
  // first is only ever a way to end up with a window full of dead tabs.
  const pane = page.locator('.pane.active');
  check('no banner in the way', (await page.locator('.restore').count()) === 0);
  await pane.locator('.xterm-screen').click();
  await page.keyboard.type('echo back-without-being-asked');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1800);
  const recovered = await pane.innerText();
  check('the tab takes typing straight away', recovered.includes('back-without-being-asked'),
    recovered.slice(-120));

  // What was on screen before the crash is still above it, with a seam so the
  // dead prompt does not read as though it were still live.
  check('the old output is still there', recovered.includes('survivor-still-alive'));
  check('a seam marks where the new shell begins', recovered.includes('new shell'),
    recovered.slice(-200));
  check(
    'and it says the command that was running was not restarted',
    recovered.includes('sleep 400') && recovered.includes('was not restarted'),
    recovered.slice(-200),
  );
  await sweepContrast(page, 'after a crash');
  await page.screenshot({ path: join(SHOTS, '06-after-crash.png') });

  await page.keyboard.type('pwd');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
  check(
    'the new shell opened in the directory the old one was in',
    (await pane.innerText()).includes('/etc/apt'),
  );
  await page.screenshot({ path: join(SHOTS, '07-after-restore.png') });

  // ---- reloading the daemon brings the window with it ---------------------
  //
  // A reload swaps the daemon for one running the code on disk, and the shells
  // cross untouched — but the page in front of you is still the one that was
  // served before the swap. A window that reconnects without reloading is a
  // window running yesterday's UI against today's daemon, which is how "I
  // reloaded and nothing changed" happens.
  //
  // Only ever done to a sandbox. Reloading the daemon somebody's real shells
  // are in, from a test, is not this file's business.
  const { dev, pid: pidBefore } = await daemonStatus();
  if (!dev) {
    console.log('\n17. reload refreshes the window — skipped (needs a CLIO_DEV=1 sandbox)');
  } else {
    console.log('\n17. reloading the daemon refreshes the window');
    await page.evaluate(() => {
      window.__servedBeforeReload = true;
    });

    await fetch(`${origin}/reload?token=${info.token}`, { method: 'POST' });

    let pidNow = pidBefore;
    for (let i = 0; i < 60 && pidNow === pidBefore; i++) {
      await sleep(500);
      try {
        pidNow = (await daemonStatus()).pid;
      } catch {
        /* mid-handover the port is nobody's for a moment */
      }
    }
    check('a daemon running the code on disk took over', pidNow !== pidBefore);

    let refreshed = false;
    for (let i = 0; i < 40 && !refreshed; i++) {
      await sleep(500);
      refreshed = await page
        .evaluate(() => window.__servedBeforeReload === undefined)
        .catch(() => false);
    }
    check('the window reloaded itself onto the new code', refreshed);
    check('with its tabs still on screen', (await page.locator('.tab').count()) >= 1);
    check('and no dead screen', await page.locator('#deadscreen').isHidden());

    await page.locator('.pane.active .xterm-screen').click();
    await page.keyboard.type('echo alive-after-reload');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1800);
    check(
      'the shell is still the same one, still taking typing',
      (await page.locator('.pane.active').innerText()).includes('alive-after-reload'),
    );
  }

  await browser.close();

  // The window this run was using is closed for good, so a later `clio` does
  // not put a test's leftovers back on somebody's desktop.
  const { ws, tabs } = await windowOnto(testWindow);
  for (const tab of tabs) ws.send(JSON.stringify({ t: 'close', id: tab.id }));
  await new Promise((r) => setTimeout(r, 800));
  ws.close();
  check(
    'the test window cleaned itself up',
    !(await daemonStatus()).containers.some((c) => c.id === testWindow),
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  console.log(`screenshots in ${SHOTS}`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('test harness error:', err);
  process.exit(1);
});
