import http from 'node:http';
import { readFileSync, writeFileSync, unlinkSync, existsSync, watch } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, dirname, extname } from 'node:path';
import { WebSocketServer } from 'ws';

import { ensureDirs, HANDSHAKE_FILE, HANDOVER_FILE, IDENTITY_FILE } from './paths.js';
import { isAlive, cwdOf } from './procinfo.js';
import { locate, spool, quote, searchBudget, MAX_SPOOL_BYTES } from './drops.js';
import { SessionManager } from './manager.js';
import { drawsSomething } from './output.js';
import { MOVING } from './screen.js';
import { ROW_STILL_MS } from './session.js';
import {
  openBrowserWindow,
  openUrl,
  browserChoices,
  notifyDesktop,
  displayKey,
} from './window.js';
import { placeWindow } from './place.js';

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

const WINDOW_WAIT_MS = 12000;
const WINDOW_ATTEMPTS = 2;

const HANDOVER_WAIT_MS = 15000;

const FIRST_HANDOVER_FD = 3;

const UI_WATCH_DEBOUNCE_MS = 300;

const BIND_ATTEMPTS = 25;

const FOCUS_REPORT = /^(?:\x1b\[[IO])+$/;

const UNSEEN_SETTLE_MS = 1200;

const MAX_DROP_FILES = 20;

const DROP_WAIT_MS = 30000;

const MAX_CLIPBOARD_CHARS = 4_000_000;

const DEV = process.env.CLIO_DEV === '1';

const WINDOW_GRACE_MS = 10000;

const KILLED_NOTICE_MS = 60 * 60 * 1000;

const KILLED_COALESCE_MS = 750;

const GOODBYE_TTL_MS = 60000;

const BROWSER_GONE_MS = 750;

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

function authorized(req, url, token) {
  return safeEqual(url.searchParams.get('token') || '', token) || safeEqual(cookieToken(req), token);
}

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

const LAUNCH_ENV_KEYS = [
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XAUTHORITY',
  'DBUS_SESSION_BUS_ADDRESS',
  'XDG_SESSION_TYPE',
];

const launchOverrides = {};

const launchEnvs = new Map();

function rememberLaunchEnv(env) {
  if (!env || typeof env !== 'object') return false;

  const arriving = {};
  for (const key of LAUNCH_ENV_KEYS) {
    if (typeof env[key] === 'string' && env[key]) arriving[key] = env[key];
  }
  if (!arriving.DISPLAY && !arriving.WAYLAND_DISPLAY) {
    let merged = false;
    for (const [key, value] of Object.entries(arriving)) {
      if (launchOverrides[key] === value) continue;
      launchOverrides[key] = value;
      merged = true;
    }
    return merged;
  }

  const changed = LAUNCH_ENV_KEYS.some((key) => launchOverrides[key] !== arriving[key]);
  for (const key of LAUNCH_ENV_KEYS) delete launchOverrides[key];
  Object.assign(launchOverrides, arriving);
  launchEnvs.set(displayKey(arriving), { ...arriving });
  return changed;
}

function windowEnv(display = null) {
  const session = (display ? launchEnvs.get(display) : null) || launchOverrides;
  if (!session.DISPLAY && !session.WAYLAND_DISPLAY) return { ...process.env };

  const env = { ...process.env };
  for (const key of LAUNCH_ENV_KEYS) delete env[key];
  return { ...env, ...session };
}

function displayHere() {
  return displayKey(windowEnv());
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

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

export function runningDaemon() {
  const info = readHandshake();
  if (info && isAlive(info.pid)) return info;
  return null;
}

function readHandover() {
  const path = process.env.CLIO_HANDOVER;
  if (!path) return null;
  if (path !== HANDOVER_FILE) {
    console.log(`[clio] ignoring a handover manifest belonging to another clio (${path})`);
    return null;
  }
  try {
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    if (!manifest || !Array.isArray(manifest.sessions)) return null;
    return manifest;
  } catch (err) {
    console.error(`[clio] could not read the handover manifest: ${err.message}`);
    return null;
  }
}

const INHERITED_SESSION_MARKERS = [
  /^CLAUDECODE$/,
  /^CLAUDE_CODE_/,
  /^CLAUDE_AGENT_SDK/,
  /^CLAUDE_(PID|EFFORT|PREVIEW_)/,
  /^AI_AGENT$/,
  /^(BAGGAGE|TRACEPARENT|TRACESTATE|OTEL_)/i,
];

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
  scrubInheritedEnv();

  const handover = readHandover();
  delete process.env.CLIO_HANDOVER;

  const existing = runningDaemon();
  if (existing && !(handover && existing.pid === handover.from)) {
    console.error(`[clio] daemon already running (pid ${existing.pid}, port ${existing.port})`);
    process.exit(3);
  }

  const identity = loadIdentity();
  const token = identity.token;
  let origin = null;
  let port = null;

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

    if (path === '/auth') {
      const ok = authorized(req, url, token);
      res.writeHead(ok ? 204 : 403, {
        'cache-control': 'no-store',
        'content-type': 'application/json',
      });
      res.end(ok ? '' : JSON.stringify({ command: launchCommand }));
      return;
    }

    if (path === '/gone') {
      if (!authorized(req, url, token)) {
        res.writeHead(403);
        res.end();
        return;
      }
      const going = url.searchParams.get('c') || '';
      if (going) {
        const stale = Date.now() - GOODBYE_TTL_MS;
        for (const [id, when] of goodbyes) if (when < stale) goodbyes.delete(id);
        goodbyes.set(going, Date.now());
      }
      res.writeHead(204, { 'cache-control': 'no-store' });
      res.end();
      return;
    }

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
            saved: saved(container),
            onScreen: containerHasClient(container.id),
            display: displaysShowing(container.id),
            closing: closing.has(container.id),
            killed: wasKilled(container.id),
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
      'x-frame-options': 'DENY',
      'content-security-policy': "frame-ancestors 'none'",
    };

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

  let clipboard = '';

  function containerHasClient(id) {
    for (const client of clients) {
      if (client.container === id) return true;
    }
    return false;
  }

  function clientsFor(id) {
    return [...clients].filter((client) => client.container === id);
  }

  function onThisDisplay(client) {
    return !client.display || client.display === displayHere();
  }

  function clientsElsewhere(id) {
    return clientsFor(id).filter((client) => !onThisDisplay(client));
  }

  function shownHere(id) {
    return clientsFor(id).some((client) => onThisDisplay(client));
  }

  function displaysShowing(id) {
    const named = clientsFor(id)
      .map((client) => client.display)
      .filter(Boolean);
    return [...new Set(named)].join(', ') || null;
  }

  const closing = new Map();

  const arrivals = new Map();

  const goodbyes = new Map();

  const killed = new Map();

  const departures = new Map();

  function goodbyeStanding(id) {
    const when = goodbyes.get(id);
    return when !== undefined && Date.now() - when < GOODBYE_TTL_MS;
  }

  function saidGoodbye(id) {
    const standing = goodbyeStanding(id);
    goodbyes.delete(id);
    return standing;
  }

  function departedTogether(id) {
    const mine = departures.get(id);
    if (mine === undefined) return false;
    if (clients.size) return false;
    let together = 0;
    for (const when of departures.values()) {
      if (Math.abs(when - mine) <= BROWSER_GONE_MS) together++;
    }
    return together > 1;
  }

  function closedOnPurpose(id) {
    return goodbyeStanding(id) && !departedTogether(id);
  }

  function closingOnPurpose(id) {
    return closing.has(id) && closedOnPurpose(id);
  }

  function wasKilled(id) {
    const when = killed.get(id);
    if (when === undefined) return false;
    if (Date.now() - when < KILLED_NOTICE_MS) return true;
    killed.delete(id);
    return false;
  }

  function scheduleContainerClose(id) {
    if (!id || closing.has(id) || containerHasClient(id)) return;
    if (!manager.sessionsIn(id).length) return;

    const stale = Date.now() - GOODBYE_TTL_MS;
    for (const [was, when] of departures) if (when < stale) departures.delete(was);
    departures.set(id, Date.now());

    const timer = setTimeout(() => {
      closing.delete(id);
      if (containerHasClient(id)) return;
      const sessions = manager.sessionsIn(id);
      if (!sessions.length) return;

      const goodbye = saidGoodbye(id);
      if (goodbye && !departedTogether(id)) {
        const count = manager.parkContainer(id);
        const name = manager.getContainer(id)?.name;
        if (count) console.log(`[clio] window closed — ${count} shell(s) kept as “${name}”`);
        return;
      }

      const container = manager.getContainer(id);
      const name = container?.name || manager.suggestName(sessions, id);
      if (goodbye) {
        console.log(
          `[clio] a window went with every other one — ${sessions.length} shell(s) left as ` +
            `they were in “${name}”; clio puts the desktop back rather than asking`,
        );
        return;
      }

      killed.set(id, Date.now());
      console.log(
        `[clio] a window's page was killed — ${sessions.length} shell(s) still running in ` +
          `“${name}”; Ctrl+R in that window brings them back, or clio if the window went too`,
      );
      announceKilled(name);
    }, WINDOW_GRACE_MS);

    timer.unref?.();
    closing.set(id, timer);
  }

  let killedPending = [];
  let killedTimer = null;

  function announceKilled(name) {
    killedPending.push(name);
    clearTimeout(killedTimer);
    killedTimer = setTimeout(() => {
      const names = killedPending;
      const many = names.length > 1;
      killedPending = [];
      if (DEV && !process.env.CLIO_NOTIFIER) return;
      notifyDesktop(
        many
          ? `clio — ${names.length} windows lost their page`
          : `clio — ${names[0] ? `“${names[0]}”` : 'a window'} lost its page`,
        (many ? 'Their pages were killed — ' : 'Its page was killed — ') +
          'out of memory, most likely. Press Ctrl+R in the window to bring the tabs back, ' +
          'or run clio if the window has gone too. The shells kept running throughout.',
      );
    }, KILLED_COALESCE_MS);
    killedTimer.unref?.();
  }

  let handingOver = false;

  function useLaunchEnv(env) {
    if (!rememberLaunchEnv(env)) return;
    manager.launchEnv = { ...launchOverrides };
    console.log(`[clio] display is now ${launchOverrides.DISPLAY || launchOverrides.WAYLAND_DISPLAY || 'unset'}`);
  }

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

  function stopListening() {
    return new Promise((resolve) => {
      for (const client of clients) {
        client.replaced = true;
        try {
          client.ws.close(1012, 'reloading');
        } catch {
        }
      }

      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };

      server.close(finish);
      server.closeAllConnections?.();
      setTimeout(finish, 1000);
    });
  }

  async function successorReady(child) {
    const deadline = Date.now() + HANDOVER_WAIT_MS;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode) return false;
      const info = readHandshake();
      if (!existsSync(HANDOVER_FILE) && info && info.pid !== process.pid && isAlive(info.pid)) {
        return true;
      }
      await sleep(100);
    }
    return false;
  }

  async function handOver({ entry = ENTRY } = {}) {
    if (handingOver) return { ok: false, error: 'a reload is already under way' };
    handingOver = true;

    const successorEntry = typeof entry === 'string' && existsSync(entry) ? entry : ENTRY;
    if (successorEntry !== ENTRY) console.log(`[clio] handing over to ${successorEntry}`);

    manager.pauseAll();
    for (const id of [...bursts.keys()]) decideUnseen(id, { wait: false });
    manager.saveNow();

    const fds = [];
    const sessions = manager.list().map((session) => {
      const carried = {
        ...session.toState(),
        pid: session.shellPid,
        extPid: session.ext?.pid ?? null,
        unseenOutput: session.unseenOutput,
        waiting: session.waiting,
        termTitle: session.termTitle,
        fd: null,
      };
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
      env: { ...process.env, ...launchOverrides, CLIO_HANDOVER: HANDOVER_FILE },
      stdio: ['ignore', 1, 2, ...fds],
    });
    child.unref();

    if (await successorReady(child)) {
      console.log(`[clio] pid ${child.pid} has the ${sessions.length} session(s) — standing down`);
      process.exit(0);
    }

    console.error('[clio] the replacement did not come up — keeping the shells here');
    try {
      child.kill('SIGKILL');
    } catch {
    }
    try {
      unlinkSync(HANDOVER_FILE);
    } catch {
    }

    manager.resumeAll();
    handingOver = false;

    try {
      announce(await bindPreferred(server, port, BIND_ATTEMPTS));
      console.log(`[clio] still running the old code, on ${origin}`);
      return { ok: false, error: 'the new daemon did not start; this one kept the shells' };
    } catch (err) {
      console.error('[clio] could not listen again after a failed reload:', err.message);
      return { ok: false, error: `reload failed and the daemon is no longer listening: ${err.message}` };
    }
  }

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

  function cancelContainerClose(id) {
    goodbyes.delete(id);
    departures.delete(id);
    const timer = closing.get(id);
    if (!timer) return;
    clearTimeout(timer);
    closing.delete(id);
  }

  function flushContainerCloses() {
    for (const timer of closing.values()) clearTimeout(timer);
    closing.clear();
  }

  function adoptable(container) {
    return (
      manager.sessionsIn(container.id).length &&
      !containerHasClient(container.id) &&
      !closingOnPurpose(container.id) &&
      container.closedAt === null
    );
  }

  function strandedElsewhere(container) {
    return (
      manager.sessionsIn(container.id).length &&
      container.closedAt === null &&
      !shownHere(container.id) &&
      clientsElsewhere(container.id).length > 0
    );
  }

  function saved(container) {
    return (
      manager.sessionsIn(container.id).length &&
      !containerHasClient(container.id) &&
      (container.closedAt !== null || closingOnPurpose(container.id))
    );
  }

  function savedGroups() {
    return manager
      .containerList()
      .filter(saved)
      .sort((a, b) => (b.closedAt ?? Infinity) - (a.closedAt ?? Infinity));
  }

  function groupsPayload(exceptId = null, error = null) {
    return {
      t: 'groups',
      error,
      groups: savedGroups()
        .filter((container) => container.id !== exceptId)
        .map((container) => manager.describeContainer(container)),
    };
  }

  function placeMark(containerId) {
    return `clio — putting this window back (${containerId})`;
  }

  let toldHowToPlace = false;
  function noteHowToPlace() {
    if (toldHowToPlace) return;
    toldHowToPlace = true;
    console.log(
      '[clio] install wmctrl (or xdotool) and windows will come back on the monitor they ' +
        'were on; without one they come back the size they were, wherever the browser opens them',
    );
  }

  function sessionsPayload(containerId) {
    const container = manager.getContainer(containerId);
    return {
      t: 'sessions',
      container: containerId,
      name: container?.name || null,
      geometry: container?.geometry || null,
      mark: placeMark(containerId),
      sessions: manager.sessionsIn(containerId).map((s) => s.toJSON()),
      home: process.env.HOME || '',
      dev: DEV,
    };
  }

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

  function resolveContainer(asked) {
    if (asked) {
      return manager.getContainer(asked) || manager.openContainer(asked);
    }
    const orphan = manager.containerList().find(adoptable);
    return orphan || manager.openContainer();
  }

  async function showWindow(containerId, { pick = false, display = null } = {}) {
    const where = display || displayHere();
    const env = windowEnv(where);
    const url =
      `${origin}/?token=${token}&c=${containerId}` +
      `${where ? `&d=${encodeURIComponent(where)}` : ''}${pick ? '&pick=1' : ''}`;
    const before = arrivals.get(containerId) || 0;
    const arrived = () => (arrivals.get(containerId) || 0) > before;

    for (let attempt = 1; attempt <= WINDOW_ATTEMPTS; attempt++) {
      try {
        await openBrowserWindow(url, env, {
          geometry: manager.getContainer(containerId)?.geometry || null,
        });
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

  function evictElsewhere(id, leaving) {
    const where = displayHere();
    const from =
      [...new Set(leaving.map((client) => client.display).filter(Boolean))].join(', ') ||
      'another display';

    for (const client of leaving) {
      client.moving = true;
      client.attached.clear();
      client.focused = null;
      if (client.ws.readyState === client.ws.OPEN) {
        client.ws.send(JSON.stringify({ t: 'moved', display: where }));
      }
    }

    const container = manager.getContainer(id);
    const name = container?.name || manager.suggestName(manager.sessionsIn(id), id);
    console.log(
      `[clio] “${name}” brought over from ${from} to ${where} — ` +
        `${manager.sessionsIn(id).length} tab(s), none of them restarted`,
    );
  }

  async function openWindows({ cwd = null, env = null, container = null } = {}) {
    useLaunchEnv(env);

    if (container) {
      const wanted = findContainer(container);
      if (!wanted) return { opened: [], failed: [{ id: container, error: `no window called “${container}” is waiting` }] };
      if (shownHere(wanted.id)) {
        return { opened: [], failed: [{ id: wanted.id, error: 'that window is already open' }] };
      }
      cancelContainerClose(wanted.id);
      manager.reviveContainer(wanted.id);
      const leaving = clientsElsewhere(wanted.id);
      const one = await showWindow(wanted.id);
      if (one.ok && leaving.length) evictElsewhere(wanted.id, leaving);
      return {
        opened: one.ok ? [wanted.id] : [],
        failed: one.ok ? [] : [{ id: wanted.id, error: one.error }],
        url: one.url || null,
      };
    }

    const waiting = [
      ...manager.containerList().filter(adoptable),
      ...manager.containerList().filter(strandedElsewhere),
    ].map((c) => c.id);
    const pick = !waiting.length && savedGroups().length > 0;

    const fresh = waiting.length ? null : newWindowContainer(pick ? null : cwd, { empty: pick });
    const targets = waiting.length ? waiting : [fresh.id];

    const results = await Promise.all(
      targets.map(async (id) => {
        const leaving = clientsElsewhere(id);
        const result = await showWindow(id, { pick });
        if (result.ok && leaving.length) evictElsewhere(id, leaving);
        return { id, ...result };
      }),
    );

    if (fresh && results.some((r) => r.fatal)) discardContainer(fresh.id);

    return {
      opened: results.filter((r) => r.ok).map((r) => r.id),
      failed: results.filter((r) => !r.ok).map((r) => ({ id: r.id, error: r.error })),
      url: results.find((r) => !r.ok)?.url || null,
    };
  }

  function newWindowContainer(cwd, { empty = false } = {}) {
    const container = manager.openContainer();
    if (!empty) manager.create({ container: container.id, cwd });
    return container;
  }

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

  function watchedByAnyone(id) {
    for (const client of clients) {
      if (client.focused === id) return true;
    }
    return false;
  }

  function releaseElsewhere(id, keep = null) {
    for (const client of clients) {
      if (client === keep) continue;
      client.attached.delete(id);
      if (client.focused === id) client.focused = null;
    }
  }

  manager.on('data', (id, data) => {
    const payload = JSON.stringify({ t: 'data', id, data });
    for (const client of clients) {
      if (client.attached.has(id) && client.ws.readyState === client.ws.OPEN) {
        client.ws.send(payload);
      }
    }

    const session = manager.get(id);
    if (!session) return;
    if (watchedByAnyone(id)) {
      session.markSeen();
      return;
    }
    noteUnseen(session, data);
  });

  const bursts = new Map();

  function noteUnseen(session, data) {
    let burst = bursts.get(session.id);
    if (!burst) {
      burst = { drew: false, forClio: false, again: false, timer: null };
      burst.timer = setTimeout(() => decideUnseen(session.id), UNSEEN_SETTLE_MS);
      burst.timer.unref?.();
      bursts.set(session.id, burst);
    }
    if (!burst.drew && drawsSomething(data)) burst.drew = true;
    if (!burst.forClio && session.redrawingForClio()) burst.forClio = true;
  }

  function forgetUnseen(id) {
    const burst = bursts.get(id);
    if (!burst) return;
    clearTimeout(burst.timer);
    bursts.delete(id);
  }

  function decideUnseen(id, { wait = true } = {}) {
    const burst = bursts.get(id) || { drew: false, forClio: false, again: false };
    forgetUnseen(id);
    const session = manager.get(id);
    if (!session) return;
    if (watchedByAnyone(id)) {
      session.markSeen();
      return;
    }
    if (session.arriving() && !session.atUnansweredQuestion()) {
      session.markSeen();
      return;
    }

    const news = session.screenIsNew();

    // Rows that were still moving when the question was asked are not an answer
    // to it: an animation repaints them ten times a second, and so does an agent
    // half way through a reply. Give them one settling time to stop. If they are
    // still going by then the tab is animating and there is nothing to say —
    // its next burst of output asks again anyway, and anything that arrives
    // outside the moving rows is still news while it does. A daemon standing
    // down cannot wait for anything, so it takes that silence for its answer.
    if (news === MOVING) {
      if (wait && !burst.again) {
        const settling = { ...burst, again: true, timer: null };
        settling.timer = setTimeout(() => decideUnseen(id), ROW_STILL_MS);
        settling.timer.unref?.();
        bursts.set(id, settling);
      }
      return;
    }

    let wants = session.unseenOutput;
    if (news === false) {
      wants = false;
    } else if (news === true) {
      if (burst.forClio) {
        session.markSeen();
      } else {
        wants = true;
      }
    } else if (burst.drew && !burst.forClio) {
      wants = true;
    }

    if (session.unseenOutput === wants) return;
    session.unseenOutput = wants;
    broadcastSessions();
  }

  manager.on('exit', (id, containerId) => {
    forgetUnseen(id);
    const payload = JSON.stringify({ t: 'exit', id });
    for (const client of clients) {
      if (client.container !== containerId) continue;
      client.attached.delete(id);
      if (client.ws.readyState === client.ws.OPEN) client.ws.send(payload);
    }
    broadcastSessions();
  });

  manager.on('attention', (id, waiting) => {
    const session = manager.get(id);
    if (!session) return;
    const wants = waiting && !watchedByAnyone(id);
    if (session.waiting === wants) return;
    session.waiting = wants;
    broadcastSessions();
  });

  wss.on('connection', (ws, req) => {
    const params = new URL(req.url, origin).searchParams;
    const asked = params.get('c');
    const container = resolveContainer(asked);
    cancelContainerClose(container.id);
    manager.reviveContainer(container.id);
    arrivals.set(container.id, (arrivals.get(container.id) || 0) + 1);

    const client = {
      ws,
      container: container.id,
      attached: new Set(),
      focused: null,
      picking: params.get('pick') === '1',
      display: params.get('d') || null,
      replaced: false,
      moving: false,
    };
    clients.add(client);

    const focus = (id) => {
      client.focused = id;
      const session = manager.get(id);
      if (session) {
        session.markSeen();
        forgetUnseen(id);
      }
      if (session?.unseenOutput || session?.waiting) {
        session.unseenOutput = false;
        session.waiting = false;
        broadcastSessions();
      }
    };

    const send = (msg) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    };

    const mine = (id) => manager.get(id)?.container === client.container;

    const drops = new Map();

    const forgetDrop = (token) => {
      const pending = drops.get(token);
      if (!pending) return;
      clearTimeout(pending.timer);
      drops.delete(token);
    };

    const finishDrop = (token) => {
      const pending = drops.get(token);
      if (!pending) return;
      forgetDrop(token);

      const paths = pending.paths.filter(Boolean);
      const text = paths.length ? `${paths.map(quote).join(' ')} ` : '';
      send({
        t: 'droptext',
        drop: token,
        id: pending.id,
        text,
        note: pending.notes.join(' ') || null,
      });

      if (paths.length) {
        console.log(`[clio] dropped into ${pending.id}: ${paths.join(', ')}`);
      }
    };

    const beginDrop = (token, id, items) => {
      const session = manager.get(id);
      const cwd = (session && cwdOf(session.shellPid)) || session?.cwd || null;
      const budget = searchBudget();

      const paths = [];
      const notes = [];
      const need = [];

      items.forEach((raw, index) => {
        const item = {
          name: String(raw?.name ?? ''),
          size: Number(raw?.size),
          mtime: Number(raw?.mtime),
          dir: !!raw?.dir,
        };
        paths[index] = locate(item, { cwd, home: process.env.HOME, budget });
        if (paths[index]) return;

        const named = item.name ? `“${item.name}”` : 'that';
        if (item.dir) {
          notes.push(`clio could not find the folder ${named} — dropping one only works for a folder on this machine.`);
        } else if (!(item.size >= 0) || item.size > MAX_SPOOL_BYTES) {
          notes.push(`${named} is not on this disk and is too big for clio to keep a copy of.`);
        } else {
          need.push(index);
        }
      });

      const timer = setTimeout(() => {
        notes.push('The rest of that drop never arrived.');
        finishDrop(token);
      }, DROP_WAIT_MS);
      timer.unref?.();

      drops.set(token, { id, items, paths, notes, need: new Set(need), timer });
      if (need.length) send({ t: 'dropneed', drop: token, need });
      else finishDrop(token);
    };

    send(sessionsPayload(client.container));
    if (client.picking) send(groupsPayload(client.container));

    send({ t: 'browsers', browsers: browserChoices(windowEnv()) });

    if (clipboard) send({ t: 'clipboard', text: clipboard });

    const tellIt = wasKilled(client.container);
    killed.delete(client.container);
    if (tellIt) send({ t: 'killed' });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      switch (msg.t) {
        case 'create': {
          const session = manager.create({
            container: client.container,
            cwd: msg.cwd,
            cols: msg.cols,
            rows: msg.rows,
          });
          client.picking = false;
          client.attached.add(session.id);
          focus(session.id);
          send({ t: 'created', id: session.id, session: session.toJSON() });
          break;
        }

        case 'newwindow': {
          const pick = savedGroups().length > 0;
          const container = newWindowContainer(msg.cwd, { empty: pick });
          showWindow(container.id, { pick, display: client.display }).then((result) => {
            if (result.ok) return;
            if (result.fatal) discardContainer(container.id);
            send({ t: 'window', ok: false, error: result.error });
          });
          break;
        }

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

        case 'renamewindow': {
          const target = msg.container || client.container;
          const container = manager.getContainer(target);
          if (container && (target === client.container || saved(container))) {
            manager.renameContainer(target, msg.name);
          }
          break;
        }

        case 'openurl':
          try {
            const opener = openUrl(
              msg.url,
              { ...process.env, ...launchOverrides },
              typeof msg.browser === 'string' ? msg.browser : null,
            );
            console.log(`[clio] handed a link to ${opener}`);
          } catch (err) {
            send({ t: 'link', ok: false, error: err.message });
          }
          break;

        case 'clipboard': {
          if (typeof msg.text !== 'string' || !msg.text) break;
          clipboard = msg.text.slice(0, MAX_CLIPBOARD_CHARS);
          const payload = JSON.stringify({ t: 'clipboard', text: clipboard });
          for (const other of clients) {
            if (other === client || other.ws.readyState !== other.ws.OPEN) continue;
            other.ws.send(payload);
          }
          break;
        }

        case 'geometry':
          manager.setGeometry(client.container, msg);
          break;

        case 'place': {
          const geometry = manager.getContainer(client.container)?.geometry;
          if (!geometry) {
            send({ t: 'placed', ok: false });
            break;
          }
          placeWindow(placeMark(client.container), geometry, {
            ...process.env,
            ...launchOverrides,
          })
            .then((outcome) => {
              send({ t: 'placed', ok: outcome.moved });
              if (outcome.moved) {
                console.log(`[clio] a window was put back where it was by ${outcome.tool}`);
                return;
              }
              console.log(`[clio] a window could not be put back where it was: ${outcome.why}`);
              if (outcome.install) noteHowToPlace();
            })
            .catch((err) => {
              send({ t: 'placed', ok: false });
              console.error('[clio] could not put a window back:', err.message);
            });
          break;
        }

        case 'gone':
          goodbyes.set(client.container, Date.now());
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
          focus(session.id);
          if (msg.cols && msg.rows) manager.resize(session.id, msg.cols, msg.rows);
          send({
            t: 'attached',
            id: session.id,
            scrollback: session.scrollback(),
            session: session.toJSON(),
          });
          setTimeout(() => session.nudgeRedraw(), 60);
          break;
        }

        case 'detach':
          client.attached.delete(msg.id);
          break;

        case 'input':
          if (mine(msg.id)) {
            if (FOCUS_REPORT.test(msg.data)) {
              const session = manager.get(msg.id);
              if (session) session.redrawAskedAt = Date.now();
            }
            manager.write(msg.id, msg.data);
          }
          break;

        case 'drop': {
          const token = String(msg.drop || '');
          const items = Array.isArray(msg.files) ? msg.files.slice(0, MAX_DROP_FILES) : [];
          if (!token || !items.length || drops.has(token) || !mine(msg.id)) break;
          beginDrop(token, msg.id, items);
          break;
        }

        case 'dropdata': {
          const token = String(msg.drop || '');
          const pending = drops.get(token);
          const index = Number(msg.index);
          if (!pending || !pending.need.has(index)) break;
          pending.need.delete(index);

          const name = pending.items[index]?.name;
          const named = name ? `“${String(name).slice(0, 60)}”` : 'that file';
          const data = typeof msg.data === 'string' ? msg.data : '';

          if (msg.error || !data) {
            pending.notes.push(`clio could not read ${named}.`);
          } else if (data.length > MAX_SPOOL_BYTES * 1.4) {
            pending.notes.push(`${named} is too big for clio to keep a copy of.`);
          } else {
            try {
              pending.paths[index] = spool(name, Buffer.from(data, 'base64'));
            } catch (err) {
              pending.notes.push(`clio could not keep a copy of ${named} — ${err.message}`);
            }
          }

          if (!pending.need.size) finishDrop(token);
          break;
        }

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

        case 'adopttab': {
          const session = manager.get(msg.id);
          if (!session || session.container === client.container) break;

          manager.openContainer(client.container);
          cancelContainerClose(client.container);
          manager.reviveContainer(client.container);

          if (!manager.moveToContainer(msg.id, client.container)) break;
          releaseElsewhere(msg.id, client);
          client.picking = false;
          manager.reorder((msg.ids || []).filter(mine));
          console.log(`[clio] a tab moved to window ${client.container}`);
          break;
        }

        case 'poptab': {
          if (!mine(msg.id)) break;
          const from = client.container;
          if (manager.sessionsIn(from).length < 2) break;

          const container = manager.openContainer();
          if (msg.geometry) manager.setGeometry(container.id, msg.geometry);
          if (!manager.moveToContainer(msg.id, container.id)) {
            manager.forgetContainerIfEmpty(container.id);
            break;
          }
          releaseElsewhere(msg.id);
          console.log(`[clio] a tab was pulled out of ${from} into a window of its own`);

          showWindow(container.id, { display: client.display }).then((result) => {
            if (result.ok) return;
            manager.openContainer(from);
            manager.moveToContainer(msg.id, from);
            manager.forgetContainerIfEmpty(container.id);
            send({ t: 'tab', ok: false, error: result.error });
          });
          break;
        }

        default:
          break;
      }
    });

    const left = () => {
      clients.delete(client);
      for (const token of [...drops.keys()]) forgetDrop(token);
      if (client.replaced) return;
      if (client.moving) {
        cancelContainerClose(client.container);
        return;
      }
      scheduleContainerClose(client.container);
      manager.forgetContainerIfEmpty(client.container);
    };
    ws.on('close', left);
    ws.on('error', left);
  });

  port = await bindPreferred(server, identity.port, handover ? BIND_ATTEMPTS : 1);
  announce(port);
  console.log(`[clio] daemon listening on ${origin}${DEV ? ' (dev sandbox)' : ''}`);

  if (handover) {
    try {
      unlinkSync(HANDOVER_FILE);
    } catch {
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
      if (!handingOver) unlinkSync(HANDSHAKE_FILE);
    } catch {
    }
    // Going down for good: take the session trees with us. A handover is the one case that must
    // not, because the daemon taking over adopts these ptys by fd — see Manager.reapAll. Without
    // this every stop left one shell per tab running under init, and whatever was inside it: the
    // box had six abandoned daemons' worth of them, some three weeks old, still holding files open.
    if (!handingOver) {
      try {
        const ended = manager.reapAll();
        if (ended) console.log(`[clio] ended ${ended} process(es) belonging to open sessions`);
      } catch (err) {
        console.error(`[clio] could not end session processes: ${err?.message || err}`);
      }
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('SIGUSR2', () => {
    handOver().catch((err) => console.error('[clio] reload failed:', err));
  });

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
