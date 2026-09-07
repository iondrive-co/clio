import { spawn } from 'node:child_process';
import { accessSync, constants, readFileSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROWSER_PROFILE_DIR } from './paths.js';

const ICON = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'icon-128.png');

const BROWSERS = [
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  'brave-browser',
];

export function onPath(name, env = process.env) {
  for (const dir of String(env.PATH || '').split(':')) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
    }
  }
  return null;
}

export function findBrowser(env = process.env) {
  for (const name of BROWSERS) {
    const found = onPath(name, env);
    if (found) return found;
  }
  return null;
}

const URL_OPENERS = [
  ['xdg-open', []],
  ['gio', ['open']],
];

const OPENABLE = new Set(['http:', 'https:', 'mailto:']);

export function openUrl(raw, env = process.env, browserId = null) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new Error('that does not look like a link');
  }
  if (!OPENABLE.has(url.protocol)) {
    throw new Error(`clio does not open ${url.protocol.replace(':', '')} links`);
  }

  if (browserId) {
    const browser = listBrowsers(env).find((candidate) => candidate.id === browserId);
    if (!browser) throw new Error('that browser is not on this machine any more');
    const child = spawn(browser.program, argsFor(browser, url.href), {
      detached: true,
      stdio: 'ignore',
      env,
    });
    child.unref();
    return browser.program;
  }

  const override = env.CLIO_URL_OPENER || process.env.CLIO_URL_OPENER;
  const candidates = override ? [[override, []]] : URL_OPENERS;

  for (const [command, args] of candidates) {
    const found = command.includes('/') ? command : onPath(command, env);
    if (!found) continue;
    const child = spawn(found, [...args, url.href], { detached: true, stdio: 'ignore', env });
    child.unref();
    return found;
  }

  throw new Error(
    override
      ? `${override} could not be run`
      : `nothing on this machine opens links (tried ${URL_OPENERS.map(([c]) => c).join(', ')})`,
  );
}

function applicationDirs(env) {
  const home = env.XDG_DATA_HOME || (env.HOME ? join(env.HOME, '.local', 'share') : '');
  const shared = (env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(Boolean);
  return [...(home ? [home] : []), ...shared].map((dir) => join(dir, 'applications'));
}

const INDIRECT = new Set([
  'exo-open',
  'xdg-open',
  'gio',
  'gnome-open',
  'kde-open',
  'kde-open5',
  'x-www-browser',
  'gnome-www-browser',
  'sensible-browser',
  'www-browser',
]);

function desktopEntry(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }

  const fields = {};
  let inside = false;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      if (inside) break;
      inside = trimmed === '[Desktop Entry]';
      continue;
    }
    if (!inside || !trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key.includes('[')) continue;
    if (!(key in fields)) fields[key] = trimmed.slice(eq + 1).trim();
  }
  return Object.keys(fields).length ? fields : null;
}

function execArgv(line) {
  const argv = [];
  let token = '';
  let started = false;
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '\\' && i + 1 < line.length) token += line[++i];
      else if (c === '"') quoted = false;
      else token += c;
      continue;
    }
    if (c === '"') {
      quoted = true;
      started = true;
      continue;
    }
    if (c === ' ' || c === '\t') {
      if (started) argv.push(token);
      token = '';
      started = false;
      continue;
    }
    token += c;
    started = true;
  }
  if (started) argv.push(token);
  return argv;
}

function executable(path) {
  try {
    accessSync(path, constants.X_OK);
    return path;
  } catch {
    return null;
  }
}

function runnable(argv, fields, env) {
  const program = argv[0];
  if (!program) return null;
  if (fields.TryExec) {
    const tried = fields.TryExec.includes('/')
      ? executable(fields.TryExec)
      : onPath(fields.TryExec, env);
    if (!tried) return null;
  }
  return program.includes('/') ? executable(program) : onPath(program, env);
}

export function listBrowsers(env = process.env) {
  const found = [];
  const seenId = new Set();
  const seenCommand = new Set();

  for (const dir of applicationDirs(env)) {
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }

    for (const name of names.sort()) {
      if (!name.endsWith('.desktop') || seenId.has(name)) continue;
      const fields = desktopEntry(join(dir, name));
      if (!fields) continue;
      seenId.add(name);

      if (fields.Type && fields.Type !== 'Application') continue;
      if (fields.NoDisplay === 'true' || fields.Hidden === 'true') continue;
      if (fields.Terminal === 'true') continue;
      if (!fields.Exec) continue;

      const handlesHttp = (fields.MimeType || '').includes('x-scheme-handler/http');
      const isBrowser = (fields.Categories || '').split(';').includes('WebBrowser');
      if (!handlesHttp && !isBrowser) continue;

      const argv = execArgv(fields.Exec);
      if (INDIRECT.has(basename(argv[0] || ''))) continue;
      const program = runnable(argv, fields, env);
      if (!program) continue;

      const command = [program, ...argv.slice(1)].join(' ');
      if (seenCommand.has(command)) continue;
      seenCommand.add(command);

      found.push({ id: name, name: fields.Name || name.replace(/\.desktop$/, ''), program, argv });
    }
  }

  return found.sort((a, b) => a.name.localeCompare(b.name));
}

export function browserChoices(env = process.env) {
  return listBrowsers(env).map(({ id, name }) => ({ id, name }));
}

function argsFor(browser, url) {
  const args = [];
  let placed = false;

  for (const token of browser.argv.slice(1)) {
    if (token === '%%') {
      args.push('%');
      continue;
    }
    if (/^%[uUfF]$/.test(token)) {
      if (!placed) {
        args.push(url);
        placed = true;
      }
      continue;
    }
    if (/^%[a-zA-Z]$/.test(token)) continue;
    if (token === '@@' || token === '@@u' || token === '@@U') continue;
    args.push(token);
  }

  if (!placed) args.push(url);
  return args;
}

export function notifyDesktop(summary, body, env = process.env) {
  const override = env.CLIO_NOTIFIER || process.env.CLIO_NOTIFIER;
  const command = override || 'notify-send';
  const found = command.includes('/') ? command : onPath(command, env);
  if (!found) return false;

  const args = override
    ? [summary, body]
    : ['--app-name=clio', `--icon=${ICON}`, '--urgency=critical', summary, body];

  try {
    const child = spawn(found, args, { detached: true, stdio: 'ignore', env });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

const DEFAULT_WINDOW_SIZE = '1100,700';

export function displayKey(env = process.env) {
  const key = [env.DISPLAY, env.WAYLAND_DISPLAY].filter(Boolean).join('+').replace(/^:/, '');
  return key.replace(/[^A-Za-z0-9._+-]/g, '_');
}

function profileFor(env) {
  const slug = displayKey(env);
  return slug ? `${BROWSER_PROFILE_DIR}-${slug}` : BROWSER_PROFILE_DIR;
}

export function openBrowserWindow(url, env = process.env, { geometry = null } = {}) {
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) {
    const err = new Error('no display to put a window on (DISPLAY and WAYLAND_DISPLAY are both unset)');
    err.fatal = true;
    throw err;
  }

  const browser = findBrowser(env);
  if (!browser) {
    const err = new Error(`no Chrome-family browser found (tried ${BROWSERS.join(', ')})`);
    err.fatal = true;
    throw err;
  }

  return new Promise((resolve, reject) => {
    const child = spawn(
      browser,
      [
        `--app=${url}`,
        `--user-data-dir=${profileFor(env)}`,
        '--class=clio',
        `--window-size=${geometry ? `${geometry.width},${geometry.height}` : DEFAULT_WINDOW_SIZE}`,
        ...(geometry ? [`--window-position=${geometry.x},${geometry.y}`] : []),
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=Translate,MediaRouter',
        '--password-store=basic',
      ],
      { detached: true, stdio: 'ignore', env },
    );

    const failed = (err) => {
      clearTimeout(timer);
      err.fatal = true;
      reject(err);
    };
    child.once('error', failed);
    const timer = setTimeout(() => {
      child.removeListener('error', failed);
      child.unref();
      resolve();
    }, 300);
  });
}
