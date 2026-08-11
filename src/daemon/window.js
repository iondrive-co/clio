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
export function openBrowserWindow(url, env = process.env) {
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
        '--window-size=1100,700',
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
