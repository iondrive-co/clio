import http from 'node:http';
import { readFileSync, writeFileSync, unlinkSync, existsSync, watch } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, dirname, extname } from 'node:path';
import { WebSocketServer } from 'ws';

import { ensureDirs, HANDSHAKE_FILE, HANDOVER_FILE, IDENTITY_FILE } from './paths.js';
import { isAlive } from './procinfo.js';
import { SessionManager } from './manager.js';
import { openBrowserWindow, openUrl } from './window.js';

const ENTRY = fileURLToPath(import.meta.url);
const HERE = dirname(ENTRY);
const ROOT = join(HERE, '..', '..');
const UI = join(ROOT, 'src', 'ui');
const MODULES = join(ROOT, 'node_modules');

const HOST = '127.0.0.1';

const STATIC_ROUTES = {
  '/': [join(UI, 'index.html'), 'text/html; charset=utf-8'],
  '/app.js': [join(UI, 'app.js'), 'text/javascript; charset=utf-8'],
  '/style.css': [join(UI, 'style.css'), 'text/css; charset=utf-8'],
  // Chrome takes the app window's taskbar icon from the page favicon.
  '/icon.png': [join(ROOT, 'assets', 'icon-256.png'), 'image/png'],
  '/icon-128.png': [join(ROOT, 'assets', 'icon-128.png'), 'image/png'],
  '/icon-32.png': [join(ROOT, 'assets', 'icon-32.png'), 'image/png'],
  '/icon.svg': [join(ROOT, 'assets', 'icon.svg'), 'image/svg+xml'],
  '/favicon.ico': [join(ROOT, 'assets', 'icon-32.png'), 'image/png'],
  '/vendor/xterm.js': [join(MODULES, '@xterm/xterm/lib/xterm.js'), 'text/javascript'],
  '/vendor/xterm.css': [join(MODULES, '@xterm/xterm/css/xterm.css'), 'text/css'],
  '/vendor/addon-fit.js': [join(MODULES, '@xterm/addon-fit/lib/addon-fit.js'), 'text/javascript'],
  '/vendor/addon-web-links.js': [
    join(MODULES, '@xterm/addon-web-links/lib/addon-web-links.js'),
    'text/javascript',
  ],
};

const COOKIE_NAME = 'clio_token';

// How long a window gets to appear and connect before we conclude the browser
// swallowed it. Two attempts: closing a window and asking for another straight
// away can catch the browser still releasing its profile lock, in which case it
// exits without ever drawing anything.
//
// The wait is long because the cost of it being too short is the worst thing
// this can do: a first window that was merely slow arriving after a second has
// been asked for leaves two windows onto one set of tabs.
const WINDOW_WAIT_MS = 12000;
const WINDOW_ATTEMPTS = 2;

// How long a successor gets to come up and claim the shells before we conclude
// the new code is broken and take everything back.
const HANDOVER_WAIT_MS = 15000;

// Where inherited pty masters start in the successor's descriptor table. 0, 1
// and 2 are the usual three; everything above is ours to hand over.
const FIRST_HANDOVER_FD = 3;

// Long enough that an editor writing a file in several goes only reloads the
// windows once.
const UI_WATCH_DEBOUNCE_MS = 300;

// A daemon that is about to be replaced wants its own port back within seconds,
// not eventually.
const BIND_ATTEMPTS = 25;

// A sandbox instance: started with XDG_RUNTIME_DIR and XDG_STATE_HOME pointed
// somewhere disposable, so it has its own port, state and browser profile and
// shares nothing with the clio holding real shells. Set it by hand or from a
// test. Windows say so, because typing into the wrong one is the whole risk.
const DEV = process.env.CLIO_DEV === '1';

// How long a window has to come back before its tabs are put away.
//
// A page that is merely reloading drops its socket exactly as a window being
// closed does, and nothing in the event says which happened. The difference
// only shows up afterwards, in whether a window comes back for them — so the
// tabs are held on screen's terms for a moment, and a window that never returns
// is a window that was closed.
//
// Nothing is destroyed either way now: a closed window's tabs are saved under a
// name and can be opened again. The wait is still worth having, because a
// window that blinked during a reload should not turn up in the picker as
// though somebody had put it away.
const WINDOW_GRACE_MS = 10000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function cookieToken(req) {
  const raw = req.headers.cookie;
  if (!raw) return '';
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === COOKIE_NAME) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return '';
}

/**
 * A request is authorized by the token in its query string or by the cookie we
 * handed out earlier.
 *
 * The cookie is what makes a reload survivable: the URL token is stripped from
 * the address bar as soon as the page loads, so without a cookie a refresh
 * would leave the window with no way to prove itself and every button would
 * quietly stop working.
 */
function authorized(req, url, token) {
  return safeEqual(url.searchParams.get('token') || '', token) || safeEqual(cookieToken(req), token);
}

/** Listen on `port` (0 = any free port), resolving with the port actually bound. */
function listenOn(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(server.address().port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, HOST);
  });
}

function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > limit) {
        req.destroy();
        resolve(null);
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

/*
 * Spawning a browser needs to know which display to put it on, and the daemon
 * only knows what it inherited from whatever started it. That can go stale — a
 * daemon outliving the session that launched it keeps pointing at a display
 * that is no longer there — so the launcher hands its own values over on every
 * call and the newest ones win.
 */
const LAUNCH_ENV_KEYS = [
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XAUTHORITY',
  'DBUS_SESSION_BUS_ADDRESS',
  'XDG_SESSION_TYPE',
];

const launchOverrides = {};

function rememberLaunchEnv(env) {
  if (!env || typeof env !== 'object') return false;
  let changed = false;
  for (const key of LAUNCH_ENV_KEYS) {
    if (typeof env[key] === 'string' && env[key] && launchOverrides[key] !== env[key]) {
      launchOverrides[key] = env[key];
      changed = true;
    }
  }
  return changed;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

/** Shown to a browser that arrived here without being sent by the launcher. */
function landingPage(command) {
  const cmd = escapeHtml(command);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>clio</title><style>
  html,body{height:100%;margin:0;background:#1c1c22;color:#d8d8e0;
    font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
  body{display:flex;align-items:center;justify-content:center;padding:24px}
  .card{max-width:520px}
  h1{font-size:20px;margin:0 0 12px}
  p{color:#9a9aa8;margin:0 0 16px}
  code{display:block;padding:12px 14px;background:#24242c;border:1px solid #34343f;
    border-radius:6px;color:#7aa2f7;font-family:ui-monospace,"DejaVu Sans Mono",monospace;
    user-select:all;overflow-x:auto}
  .note{font-size:13px;color:#7c7c8c;margin-top:20px}
</style></head><body><div class="card">
  <h1>clio is running — but open it from a terminal</h1>
  <p>This address needs a one-time key that only the launcher can hand over, so
     typing it in by hand lands you here. Run this instead and a window will open:</p>
  <code>${cmd}</code>
  <p class="note">Your shells are running and untouched. To type just <b>clio</b> in future:<br>
     <code style="margin-top:8px">ln -s ${cmd} ~/.local/bin/clio</code></p>
</div></body></html>`;
}

function loadIdentity() {
  try {
    const saved = JSON.parse(readFileSync(IDENTITY_FILE, 'utf8'));
    if (typeof saved.token === 'string' && saved.token.length >= 32) {
      return { token: saved.token, port: Number(saved.port) || 0 };
    }
  } catch {
    /* first run, or the file was damaged */
  }
  return { token: randomBytes(24).toString('hex'), port: 0 };
}

function saveIdentity(identity) {
  try {
    writeFileSync(IDENTITY_FILE, JSON.stringify(identity), { mode: 0o600 });
  } catch (err) {
    console.error('[clio] could not save identity:', err.message);
  }
}

export function readHandshake() {
  try {
    return JSON.parse(readFileSync(HANDSHAKE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/** The handshake file is only meaningful while the process it names is alive. */
export function runningDaemon() {
  const info = readHandshake();
  if (info && isAlive(info.pid)) return info;
  return null;
}

/**
 * The manifest a departing daemon left for this one, or null if we were started
 * the ordinary way.
 *
 * It names the sessions whose pty masters are already open in this process, put
 * there by the daemon that spawned us. Nothing in it is trusted beyond shape:
 * it is read once, at startup, from a file only this user can write.
 */
function readHandover() {
  const path = process.env.CLIO_HANDOVER;
  if (!path) return null;
  try {
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    if (!manifest || !Array.isArray(manifest.sessions)) return null;
    return manifest;
  } catch (err) {
    // Carrying on without it would restart every shell the predecessor was
    // trying to save, so say why before that happens.
    console.error(`[clio] could not read the handover manifest: ${err.message}`);
    return null;
  }
}

/*
 * What a shell in a tab must not inherit.
 *
 * The daemon takes its environment from whatever started it, and outlives that
 * by days. Every shell it opens gets a copy — so if it was started from inside
 * a coding agent's own shell, every tab for the rest of the week claims to be
 * running inside that agent's session. A `claude` started in one reads the
 * markers below and believes it is a child of a session that ended long ago:
 * it stops saving its transcript, and joins a trace nothing is listening to.
 *
 * Anything a person actually wants in their shells is set by their profile,
 * which the shell reads for itself on the way up. These are set by a process,
 * about that process, and mean nothing once it is gone.
 */
const INHERITED_SESSION_MARKERS = [
  /^CLAUDECODE$/,
  /^CLAUDE_CODE_/,
  /^CLAUDE_AGENT_SDK/,
  /^CLAUDE_(PID|EFFORT|PREVIEW_)/,
  /^AI_AGENT$/,
  // OpenTelemetry trace context: whatever spawned us was mid-span, and every
  // child would go on reporting itself as part of it.
  /^(BAGGAGE|TRACEPARENT|TRACESTATE|OTEL_)/i,
];

/**
 * Drop those markers from this process, once, before anything is spawned.
 *
 * Done to the daemon's own environment rather than at each spawn, so that the
 * shells, the browser and the successor daemon a reload starts are all equally
 * free of them — a reload otherwise carries the whole set across for as long as
 * clio keeps running.
 */
function scrubInheritedEnv() {
  const dropped = [];
  for (const key of Object.keys(process.env)) {
    if (INHERITED_SESSION_MARKERS.some((pattern) => pattern.test(key))) {
      delete process.env[key];
      dropped.push(key);
    }
  }
  if (dropped.length) {
    console.log(`[clio] not passing ${dropped.length} inherited session marker(s) to shells`);
  }
}

/**
 * Bind the port we want, waiting out a predecessor still letting go of it.
 *
 * Keeping the same port is what lets windows reconnect on their own, so it is
 * worth a few seconds of trying before settling for a different one.
 */
async function bindPreferred(server, preferred, attempts) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await listenOn(server, preferred);
    } catch (err) {
      if (err.code !== 'EADDRINUSE' && err.code !== 'EACCES') throw err;
      if (attempt === attempts) break;
      await sleep(200);
    }
  }
  console.log(`[clio] port ${preferred} unavailable, taking another`);
  return listenOn(server, 0);
}

async function main() {
  ensureDirs();
  // Before the first pty, the first browser and the first successor.
  scrubInheritedEnv();

  const handover = readHandover();

  const existing = runningDaemon();
  // The daemon we are replacing is still up while it hands over — that one is
  // expected. Any other means a second daemon, and two of those fighting over
  // one set of state is worse than not starting at all.
  if (existing && !(handover && existing.pid === handover.from)) {
    console.error(`[clio] daemon already running (pid ${existing.pid}, port ${existing.port})`);
    process.exit(3);
  }

  const identity = loadIdentity();
  const token = identity.token;
  // Assigned once the socket is bound; every handler below runs after that.
  let origin = null;
  let port = null;

  // 127.0.0.1 and localhost are the same machine but not the same origin, and
  // people type whichever they remember. Trust both spellings of ourselves.
  const allowedOrigins = () =>
    new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`]);

  const launchCommand = join(ROOT, 'bin', 'clio');

  const manager = new SessionManager();
  if (handover) {
    const taken = manager.adoptHandover(handover);
    console.log(`[clio] took ${taken} running session(s) over from pid ${handover.from}`);
  } else {
    const restored = manager.restoreFromDisk();
    if (restored) console.log(`[clio] recovered ${restored} session(s) from the last run`);
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, origin);
    const path = url.pathname;

    // Lets a window tell "the daemon is down" apart from "this window is no
    // longer trusted" — two failures that need very different advice.
    if (path === '/auth') {
      const ok = authorized(req, url, token);
      res.writeHead(ok ? 204 : 403, {
        'cache-control': 'no-store',
        'content-type': 'application/json',
      });
      res.end(ok ? '' : JSON.stringify({ command: launchCommand }));
      return;
    }

    // What `clio status` reports. Live rather than read back from the state
    // file, which is only written on a debounce and says nothing about which
    // windows are actually on screen.
    if (path === '/status') {
      if (!authorized(req, url, token)) {
        res.writeHead(403);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(
        JSON.stringify({
          windows: clients.size,
          dev: DEV,
          pid: process.pid,
          containers: manager.containerList().map((container) => ({
            id: container.id,
            name: container.name,
            // Put away rather than on screen: `clio` offers these by name
            // instead of opening them by itself.
            saved: saved(container),
            onScreen: containerHasClient(container.id),
            closing: closing.has(container.id),
            sessions: manager.sessionsIn(container.id).map((s) => ({
              id: s.id,
              title: s.title,
              cwd: s.cwd,
              command: s.command,
            })),
          })),
        }),
      );
      return;
    }

    // Swap this daemon for one running the code that is on disk now, keeping
    // every shell. The reply goes out first and on purpose: the socket carrying
    // it is one of the things the handover takes down.
    if (path === '/reload') {
      if (!authorized(req, url, token)) {
        res.writeHead(403);
        res.end();
      } else if (req.method !== 'POST') {
        res.writeHead(405);
        res.end();
      } else if (handingOver) {
        res.writeHead(409, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ error: 'a reload is already under way' }));
      } else {
        readJsonBody(req).then((body) => {
          // The launcher tells us which installation it is, and which desktop
          // it is being run from. Both are fresher than anything this process
          // knows about itself.
          useLaunchEnv(body?.env);
          res.writeHead(202, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ from: process.pid, sessions: manager.list().length }), () => {
            setTimeout(() => {
              handOver({ entry: body?.entry }).catch((err) =>
                console.error('[clio] reload failed:', err),
              );
            }, 100);
          });
        });
      }
      return;
    }

    // The launcher asking for windows. It does not open them itself: the + in
    // the tab row needs the same thing, and a page cannot spawn a browser.
    if (path === '/windows') {
      if (!authorized(req, url, token)) {
        res.writeHead(403);
        res.end();
      } else if (req.method !== 'POST') {
        res.writeHead(405);
        res.end();
      } else {
        readJsonBody(req).then(async (body) => {
          const result = await openWindows(body || {});
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end(JSON.stringify(result));
        });
      }
      return;
    }

    // Someone typed the address in by hand. Serving the terminal UI here would
    // load a window that cannot authenticate and dies a few seconds later, so
    // say what to run instead.
    if (path === '/' && !authorized(req, url, token)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(landingPage(launchCommand));
      return;
    }

    const route = STATIC_ROUTES[path];
    if (!route) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }

    const headers = {
      'content-type': route[1],
      'cache-control': 'no-store',
      // The page holds a live shell; never let anything embed it.
      'x-frame-options': 'DENY',
      'content-security-policy': "frame-ancestors 'none'",
    };

    // Only ever issued to a request that already proved it holds the token.
    // HttpOnly keeps it out of reach of page scripts entirely.
    if (path === '/' && safeEqual(url.searchParams.get('token') || '', token)) {
      headers['set-cookie'] =
        `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`;
    }

    try {
      const body = readFileSync(route[0]);
      res.writeHead(200, headers);
      res.end(body);
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(`could not read ${extname(route[0])} asset: ${err.message}`);
    }
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, origin);

    // Two independent gates. The token stops any other local user or stray
    // process from opening a shell here; the origin check stops a web page you
    // happen to be visiting from reaching in through your own browser.
    const tokenOk = authorized(req, url, token);
    const originOk = !req.headers.origin || allowedOrigins().has(req.headers.origin);

    if (!tokenOk || !originOk) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  const clients = new Set();

  function containerHasClient(id) {
    for (const client of clients) {
      if (client.container === id) return true;
    }
    return false;
  }

  /** Windows whose page has gone, against the timer that will put their tabs away. */
  const closing = new Map();

  /** How many windows have ever connected for a container, this daemon's life. */
  const arrivals = new Map();

  /**
   * A window's page has gone. Give it WINDOW_GRACE_MS to come back — a reload
   * takes well under a second — and if it does not, it was closed, so its tabs
   * are put away under a name and wait there to be opened again.
   */
  function scheduleContainerClose(id) {
    if (!id || closing.has(id) || containerHasClient(id)) return;
    if (!manager.sessionsIn(id).length) return;

    const timer = setTimeout(() => {
      closing.delete(id);
      if (containerHasClient(id)) return; // it made it back with nothing to spare
      const count = manager.parkContainer(id);
      const name = manager.getContainer(id)?.name;
      if (count) console.log(`[clio] window closed — ${count} shell(s) kept as “${name}”`);
    }, WINDOW_GRACE_MS);

    timer.unref?.();
    closing.set(id, timer);
  }

  /* ------------------------------------------------------------- handover */

  /*
   * Replacing the daemon without disturbing the shells.
   *
   * A pty dies when the last copy of its master descriptor is closed, and until
   * now that copy was always in this process — so every restart, however
   * careful, took the shells with it. The way out is not to keep the process
   * alive but to keep the descriptors: a successor is started with them already
   * open in its own table, and only once it says it has them does this one go.
   *
   * Nothing is destroyed on the way. If the new code cannot start, the shells
   * are still here, still ours, and this daemon carries on as though nothing
   * had been tried.
   */

  let handingOver = false;

  /**
   * Believe the launcher about the desktop this is running on.
   *
   * It arrives with every `clio` and every `clio reload`, which is what makes
   * it worth more than what the daemon inherited: a daemon started from a
   * service, a script or an agent's shell has no display in its environment at
   * all, and would otherwise hand that emptiness to every shell it opens —
   * where it surfaces much later as a link that does not open, or a `Cannot
   * open display` from something that had no reason to expect one.
   */
  function useLaunchEnv(env) {
    if (!rememberLaunchEnv(env)) return;
    // Shells already running keep the environment they were started with;
    // nothing can reach in and change that. This is for the ones after it.
    manager.launchEnv = { ...launchOverrides };
    console.log(`[clio] display is now ${launchOverrides.DISPLAY || launchOverrides.WAYLAND_DISPLAY || 'unset'}`);
  }

  /**
   * Take up an address, and leave the note that says where we are.
   *
   * Done on every bind rather than once at startup, because a daemon whose
   * handover failed binds a second time and may not get the same port back.
   */
  function announce(boundPort) {
    port = boundPort;
    origin = `http://${HOST}:${port}`;
    saveIdentity({ token, port });
    writeFileSync(
      HANDSHAKE_FILE,
      JSON.stringify({
        pid: process.pid,
        port,
        token,
        url: `${origin}/?token=${token}`,
        startedAt: Date.now(),
      }),
      { mode: 0o600 },
    );
  }

  /** Stop answering and let go of the port, without touching a single pty. */
  function stopListening() {
    return new Promise((resolve) => {
      // 1012 is "service restart", and the page treats it as a promise that we
      // are coming back: it retries immediately rather than easing off the way
      // it does for a daemon that has died.
      //
      // Marked first, and permanently. A socket we closed ourselves must never
      // be read as a window closing, and the close event for it can arrive at
      // any point afterwards — including after a failed handover has given up
      // and put everything back, which is exactly when ending a window's shells
      // would be least forgivable.
      for (const client of clients) {
        client.replaced = true;
        try {
          client.ws.close(1012, 'reloading');
        } catch {
          /* already gone */
        }
      }

      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };

      server.close(finish);
      // A connection still hanging on would hold the port past the successor's
      // first attempt at it.
      server.closeAllConnections?.();
      setTimeout(finish, 1000);
    });
  }

  /**
   * Wait for the successor to say it has the shells.
   *
   * It says so twice over: by deleting the manifest, which it does once the
   * descriptors are adopted, and by putting its own pid in the handshake file.
   * Waiting for both is what makes the failure case safe — anything less and we
   * would exit on a daemon that had started but not yet taken anything.
   */
  async function successorReady(child) {
    const deadline = Date.now() + HANDOVER_WAIT_MS;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode) return false; // died on the way up
      const info = readHandshake();
      if (!existsSync(HANDOVER_FILE) && info && info.pid !== process.pid && isAlive(info.pid)) {
        return true;
      }
      await sleep(100);
    }
    return false;
  }

  /**
   * Hand every running shell to a daemon started from the code on disk now.
   *
   * `entry` is which daemon that is. It defaults to this one's own file, but
   * the launcher sends its own — so a daemon that was started from a copy of
   * the tree somewhere, or from an older checkout, can be moved onto the
   * installation you are actually running without its shells noticing. The
   * usual guarantee covers the risk: if what is over there does not start, the
   * shells stay here.
   */
  async function handOver({ entry = ENTRY } = {}) {
    if (handingOver) return { ok: false, error: 'a reload is already under way' };
    handingOver = true;

    const successorEntry = typeof entry === 'string' && existsSync(entry) ? entry : ENTRY;
    if (successorEntry !== ENTRY) console.log(`[clio] handing over to ${successorEntry}`);

    // Stop reading before anything else. What the shells write from here on
    // waits in the kernel's buffers for whoever reads next, rather than being
    // read into a process that is about to exit and never reaching a window.
    manager.pauseAll();
    manager.saveNow();

    const fds = [];
    const sessions = manager.list().map((session) => {
      const carried = {
        ...session.toState(),
        pid: session.shellPid,
        // Only meaningful to a successor that starts while the process is still
        // running, which is exactly what a handover is; it is not written to
        // disk, where a reboot would make it somebody else's pid.
        agentPid: session.agent?.pid ?? null,
        unseenOutput: session.unseenOutput,
        fd: null,
      };
      // A tab whose shell has already died has nothing to pass on. The
      // successor gives it a new one, exactly as a restart would.
      if (session.fd !== null) {
        carried.fd = FIRST_HANDOVER_FD + fds.length;
        fds.push(session.fd);
      }
      return carried;
    });

    writeFileSync(
      HANDOVER_FILE,
      JSON.stringify({ from: process.pid, containers: manager.containerList(), sessions }),
      { mode: 0o600 },
    );

    await stopListening();

    const child = spawn(process.execPath, [successorEntry], {
      detached: true,
      cwd: join(dirname(successorEntry), '..', '..'),
      // The display goes across too. A daemon that learned where the desktop is
      // must not lose it by being replaced.
      env: { ...process.env, ...launchOverrides, CLIO_HANDOVER: HANDOVER_FILE },
      // 1 and 2 are the log the launcher opened for us. Everything after is a
      // pty master, landing in the successor at FIRST_HANDOVER_FD onwards.
      stdio: ['ignore', 1, 2, ...fds],
    });
    child.unref();

    if (await successorReady(child)) {
      console.log(`[clio] pid ${child.pid} has the ${sessions.length} session(s) — standing down`);
      // Deliberately not the ordinary shutdown: the handshake file belongs to
      // the successor now, and the windows that just dropped are its to expect
      // back, not ours to give up on.
      process.exit(0);
    }

    console.error('[clio] the replacement did not come up — keeping the shells here');
    // Kill it before reading resumes: two daemons on one pty would split the
    // output between them, and half a line each is worse than either.
    try {
      child.kill('SIGKILL');
    } catch {
      /* never started */
    }
    try {
      unlinkSync(HANDOVER_FILE);
    } catch {
      /* ignore */
    }

    manager.resumeAll();
    handingOver = false;

    try {
      announce(await bindPreferred(server, port, BIND_ATTEMPTS));
      console.log(`[clio] still running the old code, on ${origin}`);
      return { ok: false, error: 'the new daemon did not start; this one kept the shells' };
    } catch (err) {
      // The shells are alive but nothing can reach them: worth shouting about.
      console.error('[clio] could not listen again after a failed reload:', err.message);
      return { ok: false, error: `reload failed and the daemon is no longer listening: ${err.message}` };
    }
  }

  /**
   * Windows reload themselves when the UI changes — in a sandbox, and nowhere
   * else.
   *
   * The pages are read off disk on every request, so a window that reloads is
   * already running whatever is there now, which makes this a fine way to work
   * on clio. It is a terrible thing to do to somebody's actual shells: the
   * daemon holding those is pointed at a git checkout, and every save while
   * anyone edits it — a rebase, a branch switch, an editor writing a swap file
   * — yanks every window on the desktop out from under them, mid-command,
   * running whatever half-finished code happened to be on disk at that instant.
   *
   * So: a sandbox (CLIO_DEV=1) watches, the clio you work in does not.
   * CLIO_UI_WATCH=1 turns it on anyway for someone who wants it and knows
   * which one they are running, and CLIO_UI_WATCH=0 turns it off in a sandbox.
   */
  function watchUi() {
    const wanted = process.env.CLIO_UI_WATCH === '1' || (DEV && process.env.CLIO_UI_WATCH !== '0');
    if (!wanted || process.env.CLIO_NO_UI_WATCH === '1') return;
    let timer = null;
    try {
      watch(UI, () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          const payload = JSON.stringify({ t: 'reload' });
          let told = 0;
          for (const client of clients) {
            if (client.ws.readyState !== client.ws.OPEN) continue;
            client.ws.send(payload);
            told++;
          }
          if (told) console.log(`[clio] ui changed — reloading ${told} window(s)`);
        }, UI_WATCH_DEBOUNCE_MS);
        timer.unref?.();
      });
    } catch (err) {
      console.log(`[clio] not watching ${UI} for changes: ${err.message}`);
    }
  }

  /** The window came back. Whatever it was, it was not a close. */
  function cancelContainerClose(id) {
    const timer = closing.get(id);
    if (!timer) return;
    clearTimeout(timer);
    closing.delete(id);
  }

  /**
   * Settle every pending close now, on the way out of the process.
   *
   * Windows still on screen are deliberately left alone: they were open when
   * the daemon went down, and `clio` puts those back by itself. Only the ones
   * whose page had already gone are put away, so that a window closed a second
   * before a reboot is still a closed window afterwards.
   */
  function flushContainerCloses() {
    for (const [id, timer] of closing) {
      clearTimeout(timer);
      if (!containerHasClient(id)) manager.parkContainer(id);
    }
    closing.clear();
  }

  /**
   * A window `clio` should put back on screen without being asked.
   *
   * These are windows that were open when the daemon stopped being able to show
   * them — a reboot, a crash, `clio stop`. Nothing was decided about them, so
   * they come back the way the desktop was left, which is what every browser
   * does with the tabs you had open.
   *
   * A window somebody closed is not one of these. It is in the picker instead,
   * under its name, and comes back when it is chosen.
   */
  function adoptable(container) {
    return (
      manager.sessionsIn(container.id).length &&
      !containerHasClient(container.id) &&
      !closing.has(container.id) &&
      container.closedAt === null
    );
  }

  /**
   * A window that was closed and kept — what the picker offers.
   *
   * Windows inside their grace period count: a page that dropped ten seconds
   * ago is on its way to being one of these, and leaving it out is exactly the
   * gap that makes typing `clio` straight after closing a window feel like the
   * tabs were thrown away.
   */
  function saved(container) {
    return (
      manager.sessionsIn(container.id).length &&
      !containerHasClient(container.id) &&
      (container.closedAt !== null || closing.has(container.id))
    );
  }

  function savedGroups() {
    return manager
      .containerList()
      .filter(saved)
      .sort((a, b) => (b.closedAt ?? Infinity) - (a.closedAt ?? Infinity));
  }

  /** The list a window showing the picker is choosing from. */
  function groupsPayload(exceptId = null, error = null) {
    return {
      t: 'groups',
      error,
      groups: savedGroups()
        .filter((container) => container.id !== exceptId)
        .map((container) => manager.describeContainer(container)),
    };
  }

  function sessionsPayload(containerId) {
    const container = manager.getContainer(containerId);
    return {
      t: 'sessions',
      container: containerId,
      // Only a name somebody chose. The automatic one is what a window is
      // called once it has been put away, and showing it in an open window's
      // title would be a name nobody picked following them around.
      name: container?.name || null,
      sessions: manager.sessionsIn(containerId).map((s) => s.toJSON()),
      home: process.env.HOME || '',
      // A sandbox window says so in the tab row. Two clios on screen look
      // identical otherwise, and typing into the wrong one is the whole risk.
      dev: DEV,
    };
  }

  /** Every window is told about its own tabs and nobody else's. */
  function broadcastSessions() {
    const byContainer = new Map();
    for (const client of clients) {
      if (client.ws.readyState !== client.ws.OPEN) continue;
      let payload = byContainer.get(client.container);
      if (!payload) {
        payload = JSON.stringify(sessionsPayload(client.container));
        byContainer.set(client.container, payload);
      }
      client.ws.send(payload);
    }
  }

  /**
   * Keep every open picker honest.
   *
   * The list it is showing is of windows nobody is looking at, and that can
   * stop being true while it is on screen — another window opens one, or its
   * last tab exits.
   */
  function broadcastGroups() {
    for (const client of clients) {
      if (!client.picking || client.ws.readyState !== client.ws.OPEN) continue;
      client.ws.send(JSON.stringify(groupsPayload(client.container)));
    }
  }

  manager.on('update', () => {
    broadcastSessions();
    broadcastGroups();
  });
  manager.on('containers', () => {
    broadcastSessions();
    broadcastGroups();
  });

  /**
   * Which window's tabs a fresh connection is for.
   *
   * The launcher names the container in the URL, and a window keeps that name
   * across reloads and daemon restarts — that is what makes a window come back
   * as itself rather than as a new one.
   */
  function resolveContainer(asked) {
    if (asked) {
      // An id we have never seen is created under the name asked for, so a
      // window that outlived the container it was showing keeps its identity.
      return manager.getContainer(asked) || manager.openContainer(asked);
    }
    // Nothing asked for: adopt tabs that no window is showing before making new
    // ones, so `clio` after a reboot lands on the shells that were left behind.
    const orphan = manager.containerList().find(adoptable);
    return orphan || manager.openContainer();
  }

  /**
   * Put a window on screen for one container, and wait for it to prove it
   * arrived. Reporting success on the strength of having spawned a browser is
   * how a launch that failed silently ends up looking like it worked.
   *
   * Arrival is counted rather than looked for, because a window showing the
   * picker leaves the container it opened on the moment somebody chooses
   * another — and "does this container have a window?" would go back to false
   * mid-wait and put a second browser on the desktop.
   */
  async function showWindow(containerId, { pick = false } = {}) {
    const url = `${origin}/?token=${token}&c=${containerId}${pick ? '&pick=1' : ''}`;
    const before = arrivals.get(containerId) || 0;
    const arrived = () => (arrivals.get(containerId) || 0) > before;

    for (let attempt = 1; attempt <= WINDOW_ATTEMPTS; attempt++) {
      try {
        await openBrowserWindow(url, { ...process.env, ...launchOverrides });
      } catch (err) {
        return { ok: false, fatal: true, error: err.message, url };
      }

      const deadline = Date.now() + WINDOW_WAIT_MS;
      while (Date.now() < deadline) {
        if (arrived()) return { ok: true };
        await sleep(150);
      }
      if (attempt < WINDOW_ATTEMPTS) console.log('[clio] window did not appear — retrying');
    }

    return { ok: false, error: 'the window did not appear', url };
  }

  /**
   * What `clio` asks for, in the order the answers matter.
   *
   * 1. Windows that were open when the daemon stopped: every one of them comes
   *    back, on its own, as it was. This is the reboot and the crash, and it is
   *    the reason any of this exists.
   * 2. Otherwise, if there are windows put away, one window opens onto the
   *    picker so the choice of which — or a new one — is the user's.
   * 3. Otherwise a new window with a shell in it, which is what running a
   *    terminal emulator has always done.
   */
  async function openWindows({ cwd = null, env = null, container = null } = {}) {
    useLaunchEnv(env);

    // One window by name: `clio open core`, which is the terminal's way of
    // reaching into the picker without one being on screen.
    if (container) {
      const wanted = findContainer(container);
      if (!wanted) return { opened: [], failed: [{ id: container, error: `no window called “${container}” is waiting` }] };
      if (containerHasClient(wanted.id)) {
        return { opened: [], failed: [{ id: wanted.id, error: 'that window is already open' }] };
      }
      cancelContainerClose(wanted.id);
      manager.reviveContainer(wanted.id);
      const one = await showWindow(wanted.id);
      return {
        opened: one.ok ? [wanted.id] : [],
        failed: one.ok ? [] : [{ id: wanted.id, error: one.error }],
        url: one.url || null,
      };
    }

    const orphans = manager.containerList().filter(adoptable).map((c) => c.id);
    const pick = !orphans.length && savedGroups().length > 0;

    const fresh = orphans.length ? null : newWindowContainer(pick ? null : cwd, { empty: pick });
    const targets = orphans.length ? orphans : [fresh.id];

    const results = await Promise.all(
      targets.map(async (id) => ({ id, ...(await showWindow(id, { pick })) })),
    );

    // Nothing to retry and nothing on screen: take the shell back rather than
    // leaving a window's worth of tabs nobody asked to keep.
    if (fresh && results.some((r) => r.fatal)) discardContainer(fresh.id);

    return {
      opened: results.filter((r) => r.ok).map((r) => r.id),
      failed: results.filter((r) => !r.ok).map((r) => ({ id: r.id, error: r.error })),
      url: results.find((r) => !r.ok)?.url || null,
    };
  }

  /**
   * A new window's container, with the one shell it opens with — unless it is
   * opening onto the picker, in which case it gets its shell only if the answer
   * turns out to be "a new window", and not before.
   */
  function newWindowContainer(cwd, { empty = false } = {}) {
    const container = manager.openContainer();
    if (!empty) manager.create({ container: container.id, cwd });
    return container;
  }

  /** A window named by id or by the name it was put away under. */
  function findContainer(wanted) {
    const needle = String(wanted).trim().toLowerCase();
    const known = manager.containerList().filter((c) => manager.sessionsIn(c.id).length);
    return (
      known.find((c) => c.id === needle) ||
      known.find((c) => (c.name || '').toLowerCase() === needle) ||
      known.find((c) => (c.name || '').toLowerCase().startsWith(needle)) ||
      null
    );
  }

  function discardContainer(id) {
    for (const session of manager.sessionsIn(id)) manager.close(session.id);
    manager.forgetContainerIfEmpty(id);
  }

  /** True while at least one open window has this session on screen. */
  function watchedByAnyone(id) {
    for (const client of clients) {
      if (client.focused === id) return true;
    }
    return false;
  }

  manager.on('data', (id, data) => {
    const payload = JSON.stringify({ t: 'data', id, data });
    for (const client of clients) {
      if (client.attached.has(id) && client.ws.readyState === client.ws.OPEN) {
        client.ws.send(payload);
      }
    }

    // Flag activity in tabs nobody is looking at. Only the false->true edge
    // broadcasts, so a chatty build does not spam every window with updates.
    const session = manager.get(id);
    if (session && !session.unseenOutput && !watchedByAnyone(id)) {
      session.unseenOutput = true;
      broadcastSessions();
    }
  });

  manager.on('exit', (id, containerId) => {
    const payload = JSON.stringify({ t: 'exit', id });
    for (const client of clients) {
      if (client.container !== containerId) continue;
      client.attached.delete(id);
      if (client.ws.readyState === client.ws.OPEN) client.ws.send(payload);
    }
    broadcastSessions();
  });

  wss.on('connection', (ws, req) => {
    const params = new URL(req.url, origin).searchParams;
    const asked = params.get('c');
    const container = resolveContainer(asked);
    // A window showing these tabs again: whatever dropped the last connection,
    // it was not the window being closed.
    cancelContainerClose(container.id);
    manager.reviveContainer(container.id);
    arrivals.set(container.id, (arrivals.get(container.id) || 0) + 1);

    const client = {
      ws,
      container: container.id,
      attached: new Set(),
      focused: null,
      // This window has not chosen which tabs it is showing yet; it is on the
      // picker. Until it does, it is holding an empty container of its own.
      picking: params.get('pick') === '1',
      // Set when this daemon closes the socket itself to make way for its
      // replacement; see stopListening.
      replaced: false,
    };
    clients.add(client);

    /** Mark a session as being looked at, clearing any activity flag. */
    const focus = (id) => {
      client.focused = id;
      const session = manager.get(id);
      if (session?.unseenOutput) {
        session.unseenOutput = false;
        broadcastSessions();
      }
    };

    const send = (msg) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    };

    /**
     * True when this session is one of the tabs this window is showing.
     *
     * A window is only ever told about its own, so anything else is a stale id
     * left over from before a restart — and acting on one would type into, or
     * close, a shell belonging to a window somewhere else on the desktop.
     */
    const mine = (id) => manager.get(id)?.container === client.container;

    send(sessionsPayload(client.container));
    if (client.picking) send(groupsPayload(client.container));

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      switch (msg.t) {
        case 'create': {
          // openContainer inside create brings the container back if its last
          // tab was closed a moment ago; the window keeps the same identity.
          const session = manager.create({
            container: client.container,
            cwd: msg.cwd,
            cols: msg.cols,
            rows: msg.rows,
          });
          // Opening a tab is an answer to the picker: this is a new window.
          client.picking = false;
          client.attached.add(session.id);
          focus(session.id);
          send({ t: 'created', id: session.id, session: session.toJSON() });
          break;
        }

        // A window cannot spawn a browser, so it asks the daemon for one. The
        // new window is its own container: nothing it does can disturb this one.
        // With windows put away waiting, it opens on the picker, so + is also
        // how you get one of them back.
        case 'newwindow': {
          const pick = savedGroups().length > 0;
          const container = newWindowContainer(msg.cwd, { empty: pick });
          showWindow(container.id, { pick }).then((result) => {
            if (result.ok) return;
            if (result.fatal) discardContainer(container.id);
            send({ t: 'window', ok: false, error: result.error });
          });
          break;
        }

        /*
         * This window is taking over a set of tabs that was put away.
         *
         * The window it arrived on is given up in the same breath — it was an
         * empty frame waiting for this answer — and the tabs are only ever
         * handed over if nothing else is showing them, because two windows onto
         * one set of shells is the one thing containers exist to prevent.
         */
        case 'adopt': {
          const wanted = msg.container ? manager.getContainer(msg.container) : null;
          if (!wanted || !manager.sessionsIn(wanted.id).length) {
            send(groupsPayload(client.container, 'that window is not there any more'));
            break;
          }
          if (containerHasClient(wanted.id)) {
            send(groupsPayload(client.container, 'that window is already open'));
            break;
          }

          const previous = client.container;
          cancelContainerClose(wanted.id);
          manager.reviveContainer(wanted.id);
          arrivals.set(wanted.id, (arrivals.get(wanted.id) || 0) + 1);

          client.container = wanted.id;
          client.picking = false;
          client.attached.clear();
          client.focused = null;
          if (previous !== wanted.id) manager.forgetContainerIfEmpty(previous);

          send(sessionsPayload(wanted.id));
          break;
        }

        // Being rid of a window that was put away, which is the only place the
        // shells in one are ever ended without being asked for tab by tab.
        case 'discard': {
          const target = msg.container;
          const container = target ? manager.getContainer(target) : null;
          if (container && target !== client.container && saved(container)) {
            const count = manager.sessionsIn(target).length;
            cancelContainerClose(target);
            manager.closeContainer(target);
            console.log(`[clio] “${container.name || target}” discarded — ended ${count} shell(s)`);
          }
          send(groupsPayload(client.container));
          break;
        }

        // Naming a window: the one this page is showing by default, or one in
        // the picker being labelled before it is opened.
        case 'renamewindow': {
          const target = msg.container || client.container;
          const container = manager.getContainer(target);
          if (container && (target === client.container || saved(container))) {
            manager.renameContainer(target, msg.name);
          }
          break;
        }

        // A link in a tab was clicked. A page cannot start a program, and this
        // one should not be choosing the browser anyway: the desktop knows
        // which one, and will put it in a tab of the window already open.
        case 'openurl':
          try {
            // The launcher's display, not whatever this daemon was born with,
            // for the same reason opening a window uses it.
            const opener = openUrl(msg.url, { ...process.env, ...launchOverrides });
            // Deliberately not logging the link itself: what someone clicks in
            // their own terminal is not the daemon log's business.
            console.log(`[clio] handed a link to ${opener}`);
          } catch (err) {
            send({ t: 'link', ok: false, error: err.message });
          }
          break;

        case 'focus':
          if (mine(msg.id)) focus(msg.id);
          break;

        case 'attach': {
          const session = manager.get(msg.id);
          if (!mine(msg.id)) {
            send({ t: 'gone', id: msg.id });
            break;
          }
          client.attached.add(session.id);
          if (msg.cols && msg.rows) manager.resize(session.id, msg.cols, msg.rows);
          send({
            t: 'attached',
            id: session.id,
            scrollback: session.scrollback(),
            session: session.toJSON(),
          });
          // Let the replayed buffer land before asking apps to repaint over it.
          setTimeout(() => session.nudgeRedraw(), 60);
          break;
        }

        case 'detach':
          client.attached.delete(msg.id);
          break;

        case 'input':
          if (mine(msg.id)) manager.write(msg.id, msg.data);
          break;

        case 'resize':
          if (mine(msg.id)) manager.resize(msg.id, msg.cols, msg.rows);
          break;

        case 'close':
          if (mine(msg.id)) manager.close(msg.id);
          break;

        case 'rename':
          if (mine(msg.id)) manager.rename(msg.id, msg.title);
          break;

        case 'reorder':
          manager.reorder((msg.ids || []).filter(mine));
          break;

        default:
          break;
      }
    });

    // The page is gone — closed, reloading, or crashed. Which of those it was is
    // decided by whether anything comes back for these tabs; see
    // scheduleContainerClose.
    const left = () => {
      clients.delete(client);
      // A socket the daemon closed on its way out of the way of a replacement.
      // The page is already coming back to whoever is listening now.
      if (client.replaced) return;
      scheduleContainerClose(client.container);
      // A window with nothing in it — one closed while still on the picker,
      // most likely — leaves no window behind: there is nothing to put away,
      // and an empty frame in the list is worse than no entry at all.
      manager.forgetContainerIfEmpty(client.container);
    };
    ws.on('close', left);
    ws.on('error', left);
  });

  // Prefer the port we used last time so open windows can find us again; if
  // something else has taken it in the meantime, any free port will do. A
  // successor waits the predecessor out rather than giving up on the address
  // the windows already know.
  port = await bindPreferred(server, identity.port, handover ? BIND_ATTEMPTS : 1);
  announce(port);
  console.log(`[clio] daemon listening on ${origin}${DEV ? ' (dev sandbox)' : ''}`);

  // The receipt the predecessor is waiting on: the shells are ours, it can go.
  if (handover) {
    try {
      unlinkSync(process.env.CLIO_HANDOVER);
    } catch {
      /* it will time out instead */
    }
  }

  watchUi();

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[clio] ${signal} — saving state`);
    flushContainerCloses();
    manager.saveNow();
    try {
      // Mid-handover the file on disk is the successor's, and taking it away
      // would leave a running daemon nothing could find.
      if (!handingOver) unlinkSync(HANDSHAKE_FILE);
    } catch {
      /* ignore */
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // The signal spelling of `clio reload`, for anything that has a pid rather
  // than a token to hand.
  process.on('SIGUSR2', () => {
    handOver().catch((err) => console.error('[clio] reload failed:', err));
  });

  // A crash must still leave a usable snapshot behind — that is the whole point.
  process.on('uncaughtException', (err) => {
    console.error('[clio] uncaught exception:', err);
    try {
      flushContainerCloses();
    } catch (failed) {
      console.error('[clio] could not close windows on the way out:', failed.message);
    }
    manager.saveNow();
    process.exit(1);
  });
}

main().catch((err) => {
  console.error('[clio] failed to start:', err);
  process.exit(1);
});
