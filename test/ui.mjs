import { chromium } from 'playwright';
import {
  readFileSync,
  writeFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { execSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';

delete process.env.DISPLAY;
delete process.env.WAYLAND_DISPLAY;

const SANDBOX = mkdtempSync(join(tmpdir(), 'clio-ui-'));
process.env.XDG_RUNTIME_DIR = join(SANDBOX, 'run');
process.env.XDG_STATE_HOME = join(SANDBOX, 'state');
mkdirSync(process.env.XDG_RUNTIME_DIR, { recursive: true });
mkdirSync(process.env.XDG_STATE_HOME, { recursive: true });
process.env.CLIO_DEV = '1';
process.env.CLAUDE_CONFIG_DIR = join(SANDBOX, 'claude-config');

const OPENED = join(SANDBOX, 'opened.txt');
const RAN = join(SANDBOX, 'ran.txt');
const RUNNER = join(SANDBOX, 'record-args');
const URL_OPENER = join(SANDBOX, 'record-url');

writeFileSync(URL_OPENER, `#!/bin/sh\nprintf '%s\\n' "$1" >> ${OPENED}\n`);
writeFileSync(RUNNER, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${RAN}\n`);
chmodSync(URL_OPENER, 0o755);
chmodSync(RUNNER, 0o755);
process.env.CLIO_URL_OPENER = URL_OPENER;

mkdirSync(join(SANDBOX, 'data', 'applications'), { recursive: true });
writeFileSync(
  join(SANDBOX, 'data', 'applications', 'fakefox.desktop'),
  `[Desktop Entry]\nType=Application\nName=Fakefox\nExec=${RUNNER} fakefox --new-tab %u\nMimeType=x-scheme-handler/http;\n`,
);
writeFileSync(
  join(SANDBOX, 'data', 'applications', 'catbrowser.desktop'),
  `[Desktop Entry]\nType=Application\nName=Cat Browser\nCategories=Network;WebBrowser;\nExec=${RUNNER} catbrowser %U\n`,
);
process.env.XDG_DATA_HOME = join(SANDBOX, 'data');
process.env.XDG_DATA_DIRS = join(SANDBOX, 'no-applications-here');

const HANDSHAKE = join(process.env.XDG_RUNTIME_DIR, 'clio', 'daemon.json');
const SHOTS = join(process.cwd(), 'test', 'screenshots');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function lines(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
}

const urlsOpened = () => lines(OPENED);
const browsersRun = () => lines(RAN);

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
    }
  }
}

process.on('exit', () => {
  stopDisplay();
  try {
    execSync('./bin/clio stop', { stdio: 'ignore' });
  } catch {
  }
  try {
    rmSync(SANDBOX, { recursive: true, force: true });
  } catch {
  }
});

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
    if (xvfb.exitCode !== null) continue;

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
      if (el.closest('.xterm')) continue;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      if (parseFloat(style.opacity) < 0.9) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;

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
  execSync('./bin/clio start', { stdio: 'ignore' });
  const info = JSON.parse(readFileSync(HANDSHAKE, 'utf8'));
  const origin = `http://127.0.0.1:${info.port}`;

  const daemonStatus = async () =>
    (await fetch(`${origin}/status?token=${info.token}`, { cache: 'no-store' })).json();

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

  const testWindow = randomBytes(4).toString('hex');

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1100, height: 700 } });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));

  let closeDialogs = 0;
  page.on('dialog', async (dialog) => {
    if (dialog.type() === 'beforeunload') closeDialogs++;
    await dialog.accept();
  });

  console.log('1. first load');
  await page.goto(`${origin}/?token=${info.token}&c=${testWindow}`);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: join(SHOTS, '01-first-load.png') });

  check('no dead screen', await page.locator('#deadscreen').isHidden());
  check('a tab is present', (await page.locator('.tab').count()) >= 1);
  check(
    'the window keeps its own name in the URL',
    (await page.evaluate(() => location.search)) === `?c=${testWindow}`,
    await page.evaluate(() => location.search),
  );
  check('terminal rendered', await page.locator('.xterm-screen').isVisible());
  check('no console errors', consoleErrors.length === 0, consoleErrors[0]);

  console.log('\n2. clicking + with a real mouse');
  const before = await page.locator('.tab').count();
  await page.locator('#newtab').click();
  await page.waitForTimeout(1200);
  const after = await page.locator('.tab').count();
  check('+ opened a tab', after === before + 1, `${before} -> ${after}`);

  await page.locator('#newtab').click();
  await page.waitForTimeout(1200);
  check('+ opened another tab', (await page.locator('.tab').count()) === before + 2);

  console.log('\n3. typing for real');
  await page.locator('.pane.active .xterm-screen').click();
  await page.keyboard.type('echo real-keyboard-$((3*14))');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
  const screenText = await page.locator('.pane.active').innerText();
  check('typed command produced output', screenText.includes('real-keyboard-42'));
  await page.screenshot({ path: join(SHOTS, '02-after-typing.png') });

  console.log('\n3b. a click that lands on nothing keeps the keyboard');
  const deadSpots = await page.evaluate(() => {
    const term = document.querySelector('.pane.active .term').getBoundingClientRect();
    const grid = document.querySelector('.pane.active .xterm-screen').getBoundingClientRect();
    return {
      'just under the tab row': { x: Math.round(grid.x + 60), y: Math.round(term.y + 1) },
      'on the left edge of the window': { x: Math.round(term.x + 1), y: Math.round(grid.y + 80) },
    };
  });
  for (const [where, spot] of Object.entries(deadSpots)) {
    await page.locator('.pane.active .xterm-screen').click();
    await page.mouse.click(spot.x, spot.y);
    await page.waitForTimeout(400);
    const marker = `typed-${where.replace(/\W+/g, '-')}`;
    await page.keyboard.type(`echo ${marker}`);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1200);
    const after = await page.locator('.pane.active').innerText();
    check(
      `the shell still hears the keyboard after a click ${where}`,
      after.split(marker).length - 1 >= 2,
      await page.evaluate(() => document.activeElement?.tagName),
    );
  }

  console.log('\n4. contrast (WCAG AA needs 4.5:1 for body text)');
  await sweepContrast(page, 'first load');

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

  check(
    'no render-time colour adjustment',
    (await page.evaluate(() => panes.get(activeId).term.options.minimumContrastRatio)) === 1,
    'anything above 1 blends colours toward white',
  );

  console.log('\n6. reload');
  await page.reload();
  await page.waitForTimeout(2500);
  check('leaving the page asked nothing', closeDialogs === 0, `${closeDialogs} dialogs`);
  check('still no dead screen after reload', await page.locator('#deadscreen').isHidden());
  const reloadTabs = await page.locator('.tab').count();
  check('tabs came back after reload', reloadTabs >= 3, `${reloadTabs} tabs`);
  await page.locator('#newtab').click();
  await page.waitForTimeout(1200);
  check('+ still works after reload', (await page.locator('.tab').count()) === reloadTabs + 1);
  await page.screenshot({ path: join(SHOTS, '03-after-reload.png') });

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
  check(
    'menu offers Copy and Paste',
    menuItems.some((t) => t.startsWith('Copy')) && menuItems.some((t) => t.startsWith('Paste')),
    menuItems.join(' | '),
  );
  await sweepContrast(page, 'context menu');
  await page.keyboard.press('Escape');
  await page.mouse.click(550, 400);
  await page.waitForTimeout(300);

  console.log('\n7a. copy and paste');

  const homeTab = await page.locator('.tab.active').getAttribute('data-id');
  const marker = `clip-${randomBytes(3).toString('hex')}`;
  await page.locator('.pane.active .xterm-screen').click();
  await page.waitForTimeout(400);
  await page.keyboard.press('Control+C');
  await page.waitForTimeout(400);
  await page.keyboard.type(`printf '${marker}\\n'`);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1000);

  const markerAt = await page.evaluate((word) => {
    const rows = [...document.querySelectorAll('.pane.active .xterm-rows > div')];
    const row = rows.find((r) => r.textContent.includes(word) && !r.textContent.includes('printf'));
    const span = row && [...row.children].find((c) => c.textContent.includes(word));
    if (!span) return null;
    const rect = span.getBoundingClientRect();
    return { x1: rect.x + 1, x2: rect.x + rect.width - 1, y: rect.y + rect.height / 2 };
  }, marker);
  check('the word to copy is on screen', !!markerAt);
  const markerSpot = markerAt || { x1: 100, x2: 200, y: 300 };

  const selectMarker = async () => {
    await page.mouse.move(markerSpot.x1, markerSpot.y);
    await page.mouse.down();
    await page.mouse.move(markerSpot.x2, markerSpot.y, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(300);
  };

  await selectMarker();
  await page.locator('.pane.active .xterm-screen').click({ button: 'right' });
  await page.waitForTimeout(400);
  check(
    'a drag selects, so Copy is offered rather than greyed out',
    !(await page
      .locator('#ctxmenu .item')
      .filter({ hasText: 'Copy' })
      .first()
      .evaluate((e) => e.classList.contains('disabled'))),
  );
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => new Promise(() => {}), readText: () => new Promise(() => {}) },
    });
  });

  const listener = await windowOnto(`${testWindow}-clipboard`);
  let relayed = null;
  listener.ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.t === 'clipboard') relayed = msg.text;
  });

  await selectMarker();
  const copyStarted = Date.now();
  await page.keyboard.press('Control+Insert');
  await page.waitForTimeout(1200);
  check('Ctrl+Insert copies without waiting on the browser', Date.now() - copyStarted < 3000);
  listener.ws.close();
  check('and the daemon holds it for every other window', relayed === marker, JSON.stringify(relayed));

  await page.locator('.tab').nth(1).click();
  await page.waitForTimeout(500);
  await page.locator('.pane.active .xterm-screen').click();
  await page.waitForTimeout(400);
  const pasteStarted = Date.now();
  await page.keyboard.press('Control+Shift+V');
  await page.waitForTimeout(1500);
  const pastedIn = Date.now() - pasteStarted;
  const pasted = await page.locator('.pane.active').innerText();
  check(
    'and it pastes into another tab with the browser clipboard hung',
    pasted.includes(marker),
    JSON.stringify(pasted.slice(-120)),
  );
  check('and the paste does not sit there waiting on it', pastedIn < 3000, `${pastedIn}ms`);

  await page.keyboard.press('Control+C');
  await page.waitForTimeout(400);
  await page.locator(`.tab[data-id="${homeTab}"]`).click();
  await page.waitForTimeout(400);
  await page.locator('.pane.active .xterm-screen').click({ position: { x: 5, y: 5 } });
  await page.waitForTimeout(600);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);

  const seen = (text, word) => (text.match(new RegExp(word, 'g')) || []).length;

  const kept = `kept-${randomBytes(3).toString('hex')}`;
  await page.keyboard.type(`echo ${kept}`);
  await selectMarker();
  await page.keyboard.press('Control+C');
  await page.waitForTimeout(400);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);
  const keptText = await page.locator('.pane.active').innerText();
  check(
    'Ctrl+C on a selection copies it and leaves the line alone',
    seen(keptText, kept) >= 2,
    JSON.stringify(keptText.slice(-160)),
  );

  const dropped = `dropped-${randomBytes(3).toString('hex')}`;
  await page.keyboard.type(`echo ${dropped}`);
  await page.waitForTimeout(400);
  await page.keyboard.press('Control+C');
  await page.waitForTimeout(400);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);
  const droppedText = await page.locator('.pane.active').innerText();
  check(
    'and the copy took the selection with it, so the next one interrupts',
    seen(droppedText, dropped) === 1,
    JSON.stringify(droppedText.slice(-160)),
  );

  await page.evaluate(() => {
    delete navigator.clipboard;
  });

  console.log('\n7b. naming this window');
  const naming = page.locator('#windowname');

  await page.locator('.pane.active .xterm-screen').click({ button: 'right' });
  await page.waitForTimeout(400);
  const paneMenu = await page.locator('#ctxmenu .item').allInnerTexts();
  check(
    'a tab menu does not offer to name the window',
    !paneMenu.some((t) => t.includes('Name This Window')),
    paneMenu.join(' | '),
  );
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  check('the window says it has no name yet', (await naming.innerText()) === 'name this window');

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
  check(
    'and wears it on the window',
    (await page.locator('#windowname').innerText()) === 'the window under test',
  );

  console.log('\n7c. a closed window comes back from the picker');
  const parked = randomBytes(4).toString('hex');
  const away = await windowOnto(parked);
  away.ws.send(JSON.stringify({ t: 'create', cwd: '/tmp', cols: 80, rows: 24 }));
  await sleep(1200);
  away.ws.send(JSON.stringify({ t: 'renamewindow', name: 'parked for the picker' }));
  await sleep(600);
  await fetch(`${origin}/gone?c=${parked}&token=${info.token}`, { method: 'POST' });
  away.ws.close();
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

  console.log('\n7d. a link in a tab');
  await page.locator('.pane.active .xterm-screen').click();
  await page.keyboard.type("printf 'https://example.com/thing\\n'");
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);

  const findLink = () =>
    page.evaluate(() => {
      const rows = [...document.querySelectorAll('.pane.active .xterm-rows > div')];
      const row = rows.find(
        (r) => r.textContent.includes('https://example.com/thing') && !r.textContent.includes('printf'),
      );
      const span = row && [...row.children].find((c) => c.textContent.includes('https://example.com/thing'));
      if (!span) return null;
      const rect = span.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    });
  const linkSpot = await findLink();
  check('the link is on screen', !!linkSpot);
  const at = linkSpot || { x: 900, y: 600 };

  await page.mouse.move(at.x, at.y);
  await page.waitForTimeout(300);
  await page.mouse.click(at.x, at.y);
  await page.waitForTimeout(700);
  check('a plain click opens nothing', urlsOpened().length === 0, urlsOpened().join(' | '));
  check(
    'and says how to open it instead',
    (await page.locator('#status').innerText()).includes('Ctrl+click'),
    await page.locator('#status').innerText(),
  );

  await page.keyboard.down('Control');
  await page.mouse.click(at.x, at.y);
  await page.keyboard.up('Control');
  await page.waitForTimeout(700);
  check(
    'Ctrl+click hands it to the desktop',
    urlsOpened().join() === 'https://example.com/thing',
    urlsOpened().join(' | '),
  );

  await page.mouse.move(at.x, at.y);
  await page.waitForTimeout(300);
  await page.mouse.click(at.x, at.y, { button: 'right' });
  await page.waitForTimeout(400);
  const linkMenu = await page.locator('#ctxmenu .item').allInnerTexts();
  check('right-clicking a link offers to open it', linkMenu.some((t) => t.startsWith('Open Link\n')));
  check('and to choose what opens it', linkMenu.some((t) => t.startsWith('Open Link In')));

  await page.locator('#ctxmenu .item', { hasText: 'Open Link In' }).hover();
  await page.waitForTimeout(300);
  check('the browsers are under it', await page.locator('#ctxsub').isVisible());
  const offeredBrowsers = await page.locator('#ctxsub .item').allInnerTexts();
  check(
    'and they are the ones this machine has',
    offeredBrowsers.join(', ') === 'Cat Browser, Fakefox',
    offeredBrowsers.join(', '),
  );
  await page.screenshot({ path: join(SHOTS, '04c-open-link-in.png') });
  await sweepContrast(page, 'open link in');

  await page.locator('#ctxsub .item', { hasText: 'Fakefox' }).click();
  await page.waitForTimeout(800);
  check(
    'choosing one starts it, with the arguments its .desktop file gives it',
    browsersRun().join() === 'fakefox --new-tab https://example.com/thing',
    browsersRun().join(' | '),
  );
  check('and the menu goes away', await page.locator('#ctxmenu').isHidden());
  check('with its second pane', await page.locator('#ctxsub').isHidden());
  check(
    'the desktop was not asked as well',
    urlsOpened().length === 1,
    urlsOpened().join(' | '),
  );

  await page.mouse.move(at.x, at.y + 60);
  await page.waitForTimeout(300);
  await page.mouse.click(at.x, at.y + 60, { button: 'right' });
  await page.waitForTimeout(400);
  const plainMenu = await page.locator('#ctxmenu .item').allInnerTexts();
  check(
    'a right-click away from a link says nothing about links',
    !plainMenu.some((t) => t.startsWith('Open Link')),
    plainMenu.join(' | '),
  );
  await page.keyboard.press('Escape');
  await page.mouse.click(550, 500);
  await page.waitForTimeout(300);

  await page.locator('.pane.active .xterm-screen').click();
  await page.keyboard.press('Control+C');
  await page.waitForTimeout(400);
  await page.keyboard.type("printf '\\033[?1000h\\033[?1006h'; cat -v");
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1000);

  const reportSpot = (await findLink()) || at;
  const openedBefore = urlsOpened().length;
  const screenBefore = (await page.locator('.pane.active').innerText()).length;

  await page.mouse.move(reportSpot.x, reportSpot.y);
  await page.waitForTimeout(300);
  await page.keyboard.down('Control');
  await page.mouse.click(reportSpot.x, reportSpot.y);
  await page.keyboard.up('Control');
  await page.waitForTimeout(1000);

  const afterCtrl = (await page.locator('.pane.active').innerText()).slice(screenBefore);
  check(
    'Ctrl+click on a link opens it once',
    urlsOpened().length === openedBefore + 1,
    `${urlsOpened().length - openedBefore} opened`,
  );
  check(
    'and the program in the tab is never told about that click',
    !/\[<\d+;\d+;\d+[Mm]/.test(afterCtrl),
    JSON.stringify(afterCtrl),
  );

  const screenAfter = (await page.locator('.pane.active').innerText()).length;
  await page.mouse.click(reportSpot.x, reportSpot.y);
  await page.waitForTimeout(1000);
  const afterPlain = (await page.locator('.pane.active').innerText()).slice(screenAfter);
  check(
    'an ordinary click still reaches it',
    /\[<\d+;\d+;\d+[Mm]/.test(afterPlain),
    JSON.stringify(afterPlain),
  );
  check(
    'and still opens nothing',
    urlsOpened().length === openedBefore + 1,
    `${urlsOpened().length - openedBefore} opened`,
  );

  await page.keyboard.press('Control+C');
  await page.waitForTimeout(400);
  await page.keyboard.type("printf '\\033[?1000l\\033[?1006l'");
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);

  console.log('\n8. closing tabs');
  const n = await page.locator('.tab').count();
  await page.locator('.tab').first().hover();
  await page.locator('.tab').first().locator('.tab-close').click();
  await page.waitForTimeout(1000);
  check('close button removed a tab', (await page.locator('.tab').count()) === n - 1);

  await page.locator('.pane.active .xterm-screen').click();
  const wasRow = await page.locator('.tab').count();
  do {
    await page.keyboard.press('Control+Shift+T');
    await page.waitForTimeout(1200);
  } while ((await page.locator('.tab').count()) < 3);
  const row = await page.locator('.tab').count();
  await page.locator('.tab').nth(row - 1).click();
  await page.waitForTimeout(400);
  await page.locator('.tab').nth(row - 1).hover();
  await page.locator('.tab').nth(row - 1).locator('.tab-close').click();
  await page.waitForTimeout(1000);
  const landedOn = await page.evaluate(() =>
    [...document.querySelectorAll('#tabs .tab')].findIndex((t) => t.classList.contains('active')),
  );
  check(
    'closing a tab moves to the one on its left',
    landedOn === row - 2,
    `landed on tab ${landedOn}, wanted ${row - 2}`,
  );
  while ((await page.locator('.tab').count()) > wasRow) {
    const last = await page.locator('.tab').count();
    await page.locator('.tab').nth(last - 1).hover();
    await page.locator('.tab').nth(last - 1).locator('.tab-close').click();
    await page.waitForTimeout(800);
  }
  check('the row is back to the length it was', (await page.locator('.tab').count()) === wasRow);

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

  await page.keyboard.type('echo after-the-rename');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);
  check(
    'the shell has the keyboard back afterwards',
    (await page.locator('.pane.active').innerText()).includes('after-the-rename'),
    await page.evaluate(() => document.activeElement?.tagName),
  );

  await page.reload();
  await page.waitForTimeout(2500);
  check(
    'the name survived a reload (so the daemon stored it)',
    (await page.locator('.tab-title').allInnerTexts()).some((t) => t.includes('renamed-for-real')),
  );

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

  const oneAlong = async (index, places, hold) => {
    const before = await page.evaluate(() => order.slice());
    const box = await page.locator('.tab').nth(index).boundingBox();
    const from = hold === 'right' ? box.x + box.width - 8 : box.x + 8;
    const y = box.y + box.height / 2;
    await page.mouse.move(from, y);
    await page.mouse.down();
    for (let step = 1; step <= 10; step++) {
      await page.mouse.move(from + (box.width * places * step) / 10, y);
      await page.waitForTimeout(20);
    }
    await page.mouse.up();
    await page.waitForTimeout(900);
    const want = before.slice();
    want.splice(index + places, 0, want.splice(index, 1)[0]);
    const after = await page.evaluate(() => order.slice());
    check(
      `a tab dragged one place ${places < 0 ? 'left' : 'right'}, held by its ${hold} edge, went one place ${places < 0 ? 'left' : 'right'}`,
      JSON.stringify(after) === JSON.stringify(want),
      after.join(' ') === before.join(' ') ? 'it did not move at all' : `landed ${after.join(' ')}, wanted ${want.join(' ')}`,
    );
  };

  await oneAlong(3, -1, 'right');
  await oneAlong(2, -1, 'left');
  await oneAlong(3, +1, 'left');
  await oneAlong(2, +1, 'right');

  await page.screenshot({ path: join(SHOTS, '05-final.png') });
  check('no console errors overall', consoleErrors.length === 0, consoleErrors.join(' | '));

  console.log('\n12. font');
  const font = await page.evaluate(() => {
    const t = panes.get(activeId).term.options;
    return { family: t.fontFamily, size: t.fontSize };
  });
  check('font size matches Liberation Mono 11pt at 96dpi', Math.abs(font.size - 14.667) < 0.01,
    `${font.size}px`);
  check('uses Liberation Mono first', font.family.startsWith('"Liberation Mono"'), font.family);
  const cellWidth = await page.evaluate(
    () =>
      document
        .querySelector('.pane.active .xterm-cursor-layer, .pane.active .xterm-rows')
        ?.getBoundingClientRect().width,
  );
  check('terminal actually laid out at that size', cellWidth > 0);

  console.log('\n12b. font size arrows');
  const termSizes = () => page.evaluate(() =>
    [...panes.values()].map((p) => p.term.options.fontSize));
  const headerSize = () => page.evaluate(() =>
    parseFloat(getComputedStyle(document.querySelector('.tab-title')).fontSize));

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

  const sizeNow = (await termSizes())[0];
  await page.locator('#newtab').click();
  await page.waitForTimeout(1400);
  const withNewTab = await termSizes();
  check('a tab opened afterwards uses the chosen size',
    withNewTab.every((s) => s === sizeNow), JSON.stringify(withNewTab));

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

  const display = await startDisplay();
  if (!display) {
    console.log('  - the rest needs Xvfb and a window manager of its own; skipped');
  } else {
    console.log(`  (on ${display}, started for this test and taken down after it)`);

    await page.locator('.pane.active .xterm-screen').click();
    await page.keyboard.type('cd /usr/share');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2600);

    const beforeSeed = (await daemonStatus()).containers.map((c) => c.id);
    execSync('./bin/clio', { stdio: 'ignore', env: { ...process.env, DISPLAY: display } });
    await page.waitForTimeout(1500);
    const seeded = (await daemonStatus()).containers
      .map((c) => c.id)
      .filter((id) => !beforeSeed.includes(id));

    const known = (await daemonStatus()).containers.map((c) => c.id);
    const tabsHere = await page.locator('.tab').count();

    const waiting = (await daemonStatus()).containers.filter((c) => c.saved);
    check('nothing is waiting, so + means a new shell', waiting.length === 0,
      JSON.stringify(waiting.map((c) => c.name)));

    await page.locator('#newwindow').click();

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

    if (opened) {
      const { ws, tabs } = await windowOnto(opened.id);
      for (const tab of tabs) ws.send(JSON.stringify({ t: 'close', id: tab.id }));
      await page.waitForTimeout(2500);
      ws.close();
      const left = (await daemonStatus()).containers.some((c) => c.id === opened.id);
      check('closing its last tab takes the window with it', !left);
    }

    for (const id of seeded) {
      const { ws, tabs } = await windowOnto(id);
      for (const tab of tabs) ws.send(JSON.stringify({ t: 'close', id: tab.id }));
      await page.waitForTimeout(1200);
      ws.close();
    }
    stopDisplay();
  }

  console.log('\n14. tab takes its name from the running program');
  await page.locator('#newtab').click();
  await page.waitForTimeout(1400);
  await page.locator('.pane.active .xterm-screen').click();
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

  await page.keyboard.press('Control+C');
  await page.waitForTimeout(1800);
  const afterShellTitle = await page.locator('.tab.active .tab-title').innerText();
  check('a bare user@host:path title is ignored', !afterShellTitle.includes('@'),
    afterShellTitle);

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

  console.log('\n15. activity in a background tab');
  const watched = await page.evaluate(() => activeId);
  await page.locator('#newtab').click();
  await page.waitForTimeout(1200);

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

  await page.locator(`.tab[data-id="${watched}"]`).click();
  await page.waitForTimeout(1500);
  check('moving to another tab does not flag the one just left', !(await agentFlagged()));

  await page.locator(`.tab[data-id="${agentTab}"]`).click();
  await page.waitForTimeout(1200);
  await page.evaluate(() => ws.close());
  await page.waitForTimeout(3000);
  check('the tab on screen is not flagged after a reconnect', !(await agentFlagged()));
  check(
    'and the window is working again',
    await page.evaluate(() => ws.readyState === WebSocket.OPEN),
  );

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

  await page.locator(`.tab[data-id="${watched}"]`).click();
  await page.waitForTimeout(1200);
  await page.evaluate((id) => send({ t: 'input', id, data: 'q' }), agentTab);
  await page.waitForTimeout(2000);
  check('output that draws nothing does not flag a tab', !(await agentFlagged()));

  await page.evaluate((id) => send({ t: 'input', id, data: 't' }), agentTab);
  await page.waitForTimeout(2000);
  check('nor does a tab renaming itself', !(await agentFlagged()));

  await page.evaluate((id) => send({ t: 'input', id, data: '\r' }), agentTab);
  await page.waitForTimeout(2000);
  check('real output in a background tab is still flagged', await agentFlagged());

  console.log('\n15c. a tab whose agent has stopped');
  await page.locator('#newtab').click();
  await page.waitForTimeout(1200);
  const stopped = await page.evaluate(() => activeId);
  await page.evaluate(
    (fixture) => send({ t: 'input', id: activeId, data: `node ${fixture}\r` }),
    join(process.cwd(), 'test', 'fixtures', 'claude'),
  );
  await page.waitForTimeout(3000);

  await page.locator(`.tab[data-id="${watched}"]`).click();
  await page.waitForTimeout(1200);

  const stoppedFlagged = () =>
    page.locator(`.tab[data-id="${stopped}"]`).evaluate((e) => e.classList.contains('waiting'));
  check('an agent that has not worked yet is not flagged', !(await stoppedFlagged()));

  await page.evaluate((id) => send({ t: 'input', id, data: 'a question\r' }), stopped);
  await page.waitForTimeout(9000);
  check('the tab is flagged once its agent stops', await stoppedFlagged());

  const stoppedTitle = page.locator(`.tab[data-id="${stopped}"] .tab-title`);
  const stoppedColour = await stoppedTitle.evaluate((e) => getComputedStyle(e).color);
  check('its label is amber, and not the red of unread output',
    stoppedColour === 'rgb(229, 192, 123)', stoppedColour);
  const pulse = await stoppedTitle.evaluate((e) => getComputedStyle(e).animationName);
  check('and it pulses', pulse === 'tab-waiting', pulse);
  await page.screenshot({ path: join(SHOTS, '08b-waiting.png') });

  await page.locator(`.tab[data-id="${stopped}"]`).click();
  await page.waitForTimeout(1500);
  check('looking at the tab is the answer to it', !(await stoppedFlagged()));

  await page.evaluate((id) => send({ t: 'close', id }), stopped);
  await page.waitForTimeout(800);

  console.log('\n15d. close other tabs');
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

  console.log('\n16. surviving a daemon crash');
  await page.locator('.pane.active .xterm-screen').click();
  await page.keyboard.type('cd /etc/apt && sleep 400');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(3000);

  process.kill((await daemonStatus()).pid, 'SIGKILL');
  await sleep(1000);
  execSync('./bin/clio start', { stdio: 'ignore' });
  await page.waitForTimeout(9000);

  check('window reconnected by itself', await page.locator('#deadscreen').isHidden());

  const pane = page.locator('.pane.active');
  check('no banner in the way', (await page.locator('.restore').count()) === 0);
  await pane.locator('.xterm-screen').click();
  await page.keyboard.type('echo back-without-being-asked');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1800);
  const recovered = await pane.innerText();
  check('the tab takes typing straight away', recovered.includes('back-without-being-asked'),
    recovered.slice(-120));

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
