import http from 'node:http';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, dirname, extname } from 'node:path';
import { WebSocketServer } from 'ws';

import { ensureDirs, HANDSHAKE_FILE, IDENTITY_FILE } from './paths.js';
import { isAlive } from './procinfo.js';
import { SessionManager } from './manager.js';

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

    // Lets the launcher confirm a window actually connected, rather than
    // assuming the browser it spawned got as far as opening one.
    if (path === '/clients') {
      if (!authorized(req, url, token)) {
        res.writeHead(403);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ count: clients.size }));
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

  function sessionsPayload() {
    return {
      t: 'sessions',
      sessions: manager.list().map((s) => s.toJSON()),
      home: process.env.HOME || '',
    };
  }

  function broadcastSessions() {
    const payload = JSON.stringify(sessionsPayload());
    for (const client of clients) {
      if (client.ws.readyState === client.ws.OPEN) client.ws.send(payload);
    }
  }

  manager.on('update', broadcastSessions);

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

  manager.on('exit', (id) => {
    const payload = JSON.stringify({ t: 'exit', id });
    for (const client of clients) {
      client.attached.delete(id);
      if (client.ws.readyState === client.ws.OPEN) client.ws.send(payload);
    }
    broadcastSessions();
  });

  wss.on('connection', (ws) => {
    const client = { ws, attached: new Set(), focused: null };
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

    send(sessionsPayload());

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      switch (msg.t) {
        case 'create': {
          const session = manager.create({ cwd: msg.cwd, cols: msg.cols, rows: msg.rows });
          client.attached.add(session.id);
          focus(session.id);
          send({ t: 'created', id: session.id, session: session.toJSON() });
          break;
        }

        case 'focus':
          focus(msg.id);
          break;

        case 'attach': {
          const session = manager.get(msg.id);
          if (!session) {
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
          manager.write(msg.id, msg.data);
          break;

        case 'resize':
          manager.resize(msg.id, msg.cols, msg.rows);
          break;

        case 'close':
          manager.close(msg.id);
          break;

        case 'rename':
          manager.rename(msg.id, msg.title);
          break;

        case 'reorder':
          manager.reorder(msg.ids || []);
          break;

        default:
          break;
      }
    });

    // A window closing is a viewer leaving. Nothing here touches a pty.
    ws.on('close', () => clients.delete(client));
    ws.on('error', () => clients.delete(client));
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
    manager.saveNow();
    process.exit(1);
  });
}

main().catch((err) => {
  console.error('[clio] failed to start:', err);
  process.exit(1);
});
