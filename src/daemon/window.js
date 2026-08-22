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

function onPath(name, env) {
  for (const dir of String(env.PATH || '').split(':')) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* not here */
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

// How a Linux desktop is asked to open something. Both consult the same
// mimeapps.list your file manager does, so a link clicked in clio lands in the
// browser you actually use, as a tab next to everything else you have open —
// which is what clicking a link in any other terminal does.
const URL_OPENERS = [
  ['xdg-open', []],
  ['gio', ['open']],
];

// Schemes a click in a terminal could sensibly mean. The text on screen is not
// something the user wrote — it is the contents of a file, or the output of
// whatever ran last — so this list is short on purpose.
const OPENABLE = new Set(['http:', 'https:', 'mailto:']);

/**
 * Hand a URL to the desktop, and say what opened it.
 *
 * The URL is passed as an argument to a program that is executed directly, so
 * there is no shell for anything in it to reach. Parsing it first is what makes
 * that true: what goes out is a URL with a scheme from the list above, never a
 * loose string that might read as an option.
 *
 * A browser may be named instead, by the id the window was given in the list
 * below. An id and not a command: what starts is only ever something already
 * installed on this machine, found again by looking the id up.
 *
 * CLIO_URL_OPENER names a program to use instead, for a desktop that has
 * neither of these or a person who wants a particular browser.
 */
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

// ------------------------------------------------------------------ browsers
/*
 * Every browser on this machine, by the desktop's own reckoning.
 *
 * The opener above answers "whichever browser you have chosen", which is the
 * right answer almost always and the wrong one exactly when somebody wants
 * *this* link in *that* browser — the work login in one, everything else in
 * another. The names for that choice are not clio's to invent: every browser on
 * a Linux desktop ships a .desktop file saying what it is called and how it is
 * started, and it is the same list the file manager's Open With is built from.
 */

// Where those files live, most specific first, so a browser somebody installed
// for themselves is the one found rather than the system copy of the same name.
function applicationDirs(env) {
  const home = env.XDG_DATA_HOME || (env.HOME ? join(env.HOME, '.local', 'share') : '');
  const shared = (env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(Boolean);
  return [...(home ? [home] : []), ...shared].map((dir) => join(dir, 'applications'));
}

// Programs that are not a browser but stand in front of one: the desktop's own
// launchers, and Debian's alternatives. Following any of them arrives wherever
// the default already points — which is what clicking the link does without any
// of this, and is not a choice worth a line in a menu.
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

/**
 * The [Desktop Entry] group of a .desktop file, as plain keys.
 *
 * Only that first group: the ones after it are actions — Chrome's New Incognito
 * Window, LibreWolf's profile manager — each with a Name and an Exec of its
 * own, and reading past the header would quietly answer with one of those.
 * Localised keys (Name[de]) are skipped for the same reason: the last one read
 * would win, and it would be in a language nobody here asked for.
 */
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

/**
 * Split an Exec line the way the desktop entry spec says to.
 *
 * Quotes and backslashes rather than a shell split, because that is what the
 * file is written in — and because what comes out is argv for a program run
 * directly. Nothing here reaches a shell, so a .desktop file with shell syntax
 * in it is a program with an odd argument rather than a command.
 */
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

/** The program a .desktop file names, as a path that can be run, or null. */
function runnable(argv, fields, env) {
  const program = argv[0];
  if (!program) return null;
  // TryExec is the file's own answer to "is this installed?", and a browser
  // whose package has gone often leaves its .desktop file behind.
  if (fields.TryExec) {
    const tried = fields.TryExec.includes('/')
      ? executable(fields.TryExec)
      : onPath(fields.TryExec, env);
    if (!tried) return null;
  }
  return program.includes('/') ? executable(program) : onPath(program, env);
}

/**
 * The browsers, each with the name it calls itself and the argv that starts it.
 *
 * Read afresh every time rather than kept: it is a few dozen small files, read
 * when a window connects or a link is opened, and a browser installed this
 * afternoon should be in the menu this afternoon.
 */
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
      // Even an entry that is not a browser claims its id: the same file name
      // further down the search path is the system copy of what was just read.
      seenId.add(name);

      if (fields.Type && fields.Type !== 'Application') continue;
      // NoDisplay is how a package says "this entry is plumbing" — the second,
      // identical Chrome entry that exists only to own a MIME type. Hidden
      // means deleted. Terminal means it wants one, and a link opened from a
      // menu has no tab waiting to give it.
      if (fields.NoDisplay === 'true' || fields.Hidden === 'true') continue;
      if (fields.Terminal === 'true') continue;
      if (!fields.Exec) continue;

      // What makes something a browser: it says it handles http, or it files
      // itself under WebBrowser. Firefox on this machine does only the second —
      // its MimeType line lists text/html and no scheme at all — so either test
      // used alone leaves out a browser somebody has.
      const handlesHttp = (fields.MimeType || '').includes('x-scheme-handler/http');
      const isBrowser = (fields.Categories || '').split(';').includes('WebBrowser');
      if (!handlesHttp && !isBrowser) continue;

      const argv = execArgv(fields.Exec);
      if (INDIRECT.has(basename(argv[0] || ''))) continue;
      const program = runnable(argv, fields, env);
      if (!program) continue;

      // Two files naming the same command are one browser listed twice.
      const command = [program, ...argv.slice(1)].join(' ');
      if (seenCommand.has(command)) continue;
      seenCommand.add(command);

      found.push({ id: name, name: fields.Name || name.replace(/\.desktop$/, ''), program, argv });
    }
  }

  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/** What a window is told about them: a name to show, and the id to ask back for. */
export function browserChoices(env = process.env) {
  return listBrowsers(env).map(({ id, name }) => ({ id, name }));
}

/**
 * The arguments that open one URL in one browser.
 *
 * Field codes are the desktop entry spec's placeholders. The URL goes where the
 * file says to put it, and where a file says nothing it goes on the end — a
 * browser handed a URL it was not asked for still opens it, and a browser
 * handed nothing at all opens an empty window, which is the one outcome worth
 * ruling out.
 */
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
    // %i, %c, %k and the rest are about menus and icons, not about this.
    if (/^%[a-zA-Z]$/.test(token)) continue;
    // Flatpak's way of saying "the arguments go here". The codes inside have
    // been dealt with already, and the brackets are not arguments themselves.
    if (token === '@@' || token === '@@u' || token === '@@U') continue;
    args.push(token);
  }

  if (!placed) args.push(url);
  return args;
}

/**
 * Say something on the desktop, and say whether anything was there to hear it.
 *
 * There is one thing clio has to tell somebody who is not looking at a clio
 * window: that a window's page was killed, and what is in that window now is
 * Chrome's error page rather than anything of ours. Nothing inside the window
 * can say it — the page that would have said it is the thing that died — so it
 * is said out here instead.
 *
 * Critical urgency because the notification outliving the glance matters: a
 * desktop that clears it after five seconds is a desktop where a window stays
 * dead all afternoon because nobody happened to be looking. Nothing clio has
 * to say is urgent in the battery-is-empty sense; this is the only thing it
 * says at all, and it is about a window that is not coming back on its own.
 *
 * CLIO_NOTIFIER names a program to use instead, for a desktop without
 * notify-send and for the tests, which read back what was said.
 */
export function notifyDesktop(summary, body, env = process.env) {
  const override = env.CLIO_NOTIFIER || process.env.CLIO_NOTIFIER;
  const command = override || 'notify-send';
  const found = command.includes('/') ? command : onPath(command, env);
  if (!found) return false;

  // Only notify-send is known to take these; anything named by hand is given
  // the two strings and nothing to choke on.
  const args = override
    ? [summary, body]
    : ['--app-name=clio', `--icon=${ICON}`, '--urgency=critical', summary, body];

  try {
    const child = spawn(found, args, { detached: true, stdio: 'ignore', env });
    child.unref();
    return true;
  } catch {
    // A desktop with nothing listening is one where this was never going to
    // arrive. The window is still there, and still fixable by hand.
    return false;
  }
}

/**
 * Put a clio window on screen, showing whichever container the URL names.
 *
 * The daemon does this rather than the launcher because the window is not only
 * ever asked for from a shell: the + in the tab row asks for one too, and a page
 * cannot spawn a process. Both paths land here, so a window opened by either
 * looks the same.
 *
 * Errors are flagged `fatal` when there is nothing to retry — no browser on the
 * machine is not a race, and pretending otherwise only delays the message.
 */
/*
 * The size a window opens at when nothing is known about where it was.
 * Chrome-family browsers only honour this — and --window-position — for the
 * first window of a profile's browser process; every one after that is placed
 * wherever the browser feels like, which is why the page moves itself into place
 * once it is up. See applyGeometry in ../ui/app.js. Passing them anyway is worth
 * it for the first window of the day, which is the one that would otherwise be
 * seen jumping.
 */
const DEFAULT_WINDOW_SIZE = '1100,700';

export function openBrowserWindow(url, env = process.env, { geometry = null } = {}) {
  const browser = findBrowser(env);
  if (!browser) {
    const err = new Error(`no Chrome-family browser found (tried ${BROWSERS.join(', ')})`);
    err.fatal = true;
    throw err;
  }

  return new Promise((resolve, reject) => {
    // detached, as the launcher does with setsid: without its own session the
    // browser stays in the daemon's process group and would go down with it.
    const child = spawn(
      browser,
      [
        `--app=${url}`,
        `--user-data-dir=${BROWSER_PROFILE_DIR}`,
        '--class=clio',
        `--window-size=${geometry ? `${geometry.width},${geometry.height}` : DEFAULT_WINDOW_SIZE}`,
        ...(geometry ? [`--window-position=${geometry.x},${geometry.y}`] : []),
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=Translate,MediaRouter',
      ],
      { detached: true, stdio: 'ignore', env },
    );

    // A browser that hands off to an already-running instance exits immediately,
    // so there is nothing to wait for beyond spawn failing outright.
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
