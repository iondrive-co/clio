import http from 'node:http';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, dirname, extname } from 'node:path';
import { WebSocketServer } from 'ws';

import { ensureDirs, HANDSHAKE_FILE, IDENTITY_FILE } from './paths.js';
import { isAlive } from './procinfo.js';
import { SessionManager } from './manager.js';
import { openBrowserWindow } from './window.js';

const HERE = dirname(fileURLToPath(import.meta.url));
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

// How long a window's shells outlive the connection that was showing them.
//
// Closing a window ends its tabs, but a page that is merely reloading drops its
// socket in exactly the same way, and nothing in the event says which happened.
// The difference only shows up afterwards, in whether a window comes back for
// them — so they are held for a moment, and a window that never returns is a
// window that was closed.
//
// Comfortably longer than the page's own reconnect backoff, which tops out at
// five seconds: losing that race would end the shells of a window still on
// screen, which is the worst thing this code can do.
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
  if (!env || typeof env !== 'object') return;
  for (const key of LAUNCH_ENV_KEYS) {
    if (typeof env[key] === 'string' && env[key]) launchOverrides[key] = env[key];
  }
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

async function main() {
  ensureDirs();

  const existing = runningDaemon();
  if (existing) {
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
  const restored = manager.restoreFromDisk();
  if (restored) console.log(`[clio] recovered ${restored} session(s) from the last run`);

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
          containers: manager.containerList().map((container) => ({
            id: container.id,
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

  /** Windows whose page has gone, against the timer that will end their tabs. */
  const closing = new Map();

  /**
   * A window's page has gone. Give it WINDOW_GRACE_MS to come back — a reload
   * takes well under a second — and if it does not, it was closed, so its tabs
   * close with it.
   */
  function scheduleContainerClose(id) {
    if (!id || closing.has(id) || containerHasClient(id)) return;
    if (!manager.sessionsIn(id).length) return;

    const timer = setTimeout(() => {
      closing.delete(id);
      if (containerHasClient(id)) return; // it made it back with nothing to spare
      const count = manager.sessionsIn(id).length;
      manager.closeContainer(id);
      console.log(`[clio] window closed — ended ${count} shell(s)`);
    }, WINDOW_GRACE_MS);

    timer.unref?.();
    closing.set(id, timer);
  }

  /** The window came back. Whatever it was, it was not a close. */
  function cancelContainerClose(id) {
    const timer = closing.get(id);
    if (!timer) return;
    clearTimeout(timer);
    closing.delete(id);
  }

  /**
   * Carry out every pending close now, on the way out of the process.
   *
   * Without this, a daemon going down inside a grace period would be the one
   * thing that could save a window the user had just closed: its tabs would go
   * into the state file and be handed back on the next start.
   */
  function flushContainerCloses() {
    for (const [id, timer] of closing) {
      clearTimeout(timer);
      if (!containerHasClient(id)) manager.closeContainer(id);
    }
    closing.clear();
  }

  /**
   * A window's worth of tabs that `clio` should put back on screen.
   *
   * Tabs on their way out are deliberately not offered: running `clio` in the
   * seconds after closing a window is asking for a new window, not for the one
   * just closed to be undone.
   */
  function adoptable(container) {
    return (
      manager.sessionsIn(container.id).length &&
      !containerHasClient(container.id) &&
      !closing.has(container.id)
    );
  }

  function sessionsPayload(containerId) {
    return {
      t: 'sessions',
      container: containerId,
      sessions: manager.sessionsIn(containerId).map((s) => s.toJSON()),
      home: process.env.HOME || '',
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

  manager.on('update', broadcastSessions);

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
   */
  async function showWindow(containerId) {
    const url = `${origin}/?token=${token}&c=${containerId}`;

    for (let attempt = 1; attempt <= WINDOW_ATTEMPTS; attempt++) {
      try {
        await openBrowserWindow(url, { ...process.env, ...launchOverrides });
      } catch (err) {
        return { ok: false, fatal: true, error: err.message, url };
      }

      const deadline = Date.now() + WINDOW_WAIT_MS;
      while (Date.now() < deadline) {
        if (containerHasClient(containerId)) return { ok: true };
        await sleep(150);
      }
      if (attempt < WINDOW_ATTEMPTS) console.log('[clio] window did not appear — retrying');
    }

    return { ok: false, error: 'the window did not appear', url };
  }

  /**
   * What `clio` asks for: every set of tabs with no window on it gets one back.
   *
   * In practice that is the daemon having gone down and come back — nothing
   * else leaves tabs without a window, since closing one takes its tabs with
   * it. If they all already have a window, then there was nothing to bring back
   * and asking again means asking for a new window, which is what running a
   * terminal emulator a second time has always meant.
   */
  async function openWindows({ cwd = null, env = null } = {}) {
    rememberLaunchEnv(env);

    const orphans = manager.containerList().filter(adoptable).map((c) => c.id);

    const fresh = orphans.length ? null : newWindowContainer(cwd);
    const targets = orphans.length ? orphans : [fresh.id];

    const results = await Promise.all(
      targets.map(async (id) => ({ id, ...(await showWindow(id)) })),
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

  /** A new window's container, with the one shell it opens with. */
  function newWindowContainer(cwd) {
    const container = manager.openContainer();
    manager.create({ container: container.id, cwd });
    return container;
  }

  function discardContainer(id) {
    for (const session of manager.sessionsIn(id)) manager.close(session.id);
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
    const asked = new URL(req.url, origin).searchParams.get('c');
    const container = resolveContainer(asked);
    // A window showing these tabs again: whatever dropped the last connection,
    // it was not the window being closed.
    cancelContainerClose(container.id);
    const client = { ws, container: container.id, attached: new Set(), focused: null };
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
          client.attached.add(session.id);
          focus(session.id);
          send({ t: 'created', id: session.id, session: session.toJSON() });
          break;
        }

        // A window cannot spawn a browser, so it asks the daemon for one. The
        // new window is its own container: nothing it does can disturb this one.
        case 'newwindow': {
          const container = newWindowContainer(msg.cwd);
          showWindow(container.id).then((result) => {
            if (result.ok) return;
            if (result.fatal) discardContainer(container.id);
            send({ t: 'window', ok: false, error: result.error });
          });
          break;
        }

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
      scheduleContainerClose(client.container);
    };
    ws.on('close', left);
    ws.on('error', left);
  });

  // Prefer the port we used last time so open windows can find us again; if
  // something else has taken it in the meantime, any free port will do.
  try {
    port = await listenOn(server, identity.port);
  } catch (err) {
    if (err.code !== 'EADDRINUSE' && err.code !== 'EACCES') throw err;
    console.log(`[clio] port ${identity.port} unavailable, taking another`);
    port = await listenOn(server, 0);
  }

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
  console.log(`[clio] daemon listening on ${origin}`);

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[clio] ${signal} — saving state`);
    flushContainerCloses();
    manager.saveNow();
    try {
      unlinkSync(HANDSHAKE_FILE);
    } catch {
      /* ignore */
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

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
