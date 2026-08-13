import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import { BROWSER_PROFILE_DIR } from './paths.js';

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
 * CLIO_URL_OPENER names a program to use instead, for a desktop that has
 * neither of these or a person who wants a particular browser.
 */
export function openUrl(raw, env = process.env) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new Error('that does not look like a link');
  }
  if (!OPENABLE.has(url.protocol)) {
    throw new Error(`clio does not open ${url.protocol.replace(':', '')} links`);
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
