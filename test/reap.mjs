// Closing a tab, and stopping the daemon, must take the tab's processes with them.
//
// Before this, both signalled the shell alone. A shell that dies hands its children to init, so an
// agent CLI, an ssh or a dev server started in a tab went on running with nothing able to reach
// it — this box accumulated six abandoned daemons' worth, the oldest three weeks old, still
// holding transcripts open. Immortality is a promise about a daemon being *replaced*; a stopped
// daemon leaving orphans behind is a leak.
import { mkdirSync, mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SANDBOX = mkdtempSync(join(tmpdir(), 'clio-reap-'));
process.env.XDG_RUNTIME_DIR = join(SANDBOX, 'run');
process.env.XDG_STATE_HOME = join(SANDBOX, 'state');
process.env.CLIO_DEV = '1';
process.env.CLIO_NO_UI_WATCH = '1';
delete process.env.DISPLAY;
delete process.env.WAYLAND_DISPLAY;
mkdirSync(process.env.XDG_RUNTIME_DIR, { recursive: true });
mkdirSync(process.env.XDG_STATE_HOME, { recursive: true });

const HANDSHAKE = join(process.env.XDG_RUNTIME_DIR, 'clio', 'daemon.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? `  — ${detail}` : ''}`); }
}

let daemon = null;
process.on('exit', () => {
  try { daemon?.kill('SIGKILL'); } catch {}
  try { rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
});

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
};

async function startDaemon() {
  daemon = spawn(process.execPath, [join(ROOT, 'src', 'daemon', 'index.js')], {
    env: process.env, stdio: 'ignore', detached: false,
  });
  for (let i = 0; i < 100; i++) {
    if (existsSync(HANDSHAKE)) return JSON.parse(readFileSync(HANDSHAKE, 'utf8'));
    await sleep(100);
  }
  throw new Error('daemon never wrote its handshake');
}

async function client(info) {
  const container = 'reap-test';
  const ws = new WebSocket(`ws://127.0.0.1:${info.port}/?token=${info.token}&c=${container}`, {
    origin: `http://127.0.0.1:${info.port}`,
  });
  const messages = [];
  ws.on('message', (raw) => messages.push(JSON.parse(raw)));
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  return {
    ws, messages,
    send: (m) => ws.send(JSON.stringify(m)),
    // From [from] onward, never from the top: two `create`s in one client would otherwise both
    // resolve to the first `created` message, and the test would quietly drive one session while
    // believing it had two.
    await: async (pred, { from = 0, timeout = 6000 } = {}) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const hit = messages.slice(from).find(pred);
        if (hit) return hit;
        await sleep(30);
      }
      return null;
    },
  };
}

// A tab running a plain child and a child that has deliberately left the process group. The
// setsid one is the whole reason the subtree is walked rather than only the group signalled.
async function sessionWithChildren(c) {
  const from = c.messages.length;
  c.send({ t: 'create', cwd: SANDBOX, cols: 80, rows: 24 });
  const created = await c.await((m) => m.t === 'created', { from });
  if (!created) throw new Error('no session was created');
  const plain = join(SANDBOX, `plain-${created.id}.pid`);
  const away = join(SANDBOX, `away-${created.id}.pid`);
  // The shell needs a moment to be ready for input; without it the first line is typed into
  // nothing and the test looks like a reaping failure.
  await sleep(1500);
  c.send({ t: 'input', id: created.id, data: `sh -c 'echo $$ > ${plain}; exec sleep 600' &\n` });
  await sleep(300);
  c.send({ t: 'input', id: created.id, data: `setsid sh -c 'echo $$ > ${away}; exec sleep 600' &\n` });
  for (let i = 0; i < 100; i++) {
    if (existsSync(plain) && existsSync(away)) break;
    await sleep(100);
  }
  const pids = {
    plain: Number(readFileSync(plain, 'utf8').trim()),
    away: Number(readFileSync(away, 'utf8').trim()),
  };
  if (!pids.plain || !pids.away) throw new Error('children never reported their pids');
  return { id: created.id, pids };
}

async function main() {
  const info = await startDaemon();
  const c = await client(info);

  // Both tabs up front. Closing the only session in a container tears the container down with it,
  // which would end the second tab's processes for a reason that has nothing to do with reaping.
  const one = await sessionWithChildren(c);
  const two = await sessionWithChildren(c);
  check('the two tabs really are two sessions', one.id !== two.id, `${one.id} vs ${two.id}`);

  console.log('1. closing a tab ends what was running in it');
  check('the first tab\u2019s children are running to begin with',
    alive(one.pids.plain) && alive(one.pids.away));

  c.send({ t: 'close', id: one.id });
  await sleep(2500);
  check('a child in the shell\u2019s process group is gone', !alive(one.pids.plain));
  check('a child that called setsid is gone too', !alive(one.pids.away),
    'a detached child is reachable only by its CLIO_SESSION marker');

  console.log('2. and leaves the other tab alone');
  check('the second tab\u2019s children are untouched',
    alive(two.pids.plain) && alive(two.pids.away),
    `plain ${two.pids.plain}=${alive(two.pids.plain)} away ${two.pids.away}=${alive(two.pids.away)}`);

  console.log('3. stopping the daemon ends what its tabs were running');
  daemon.kill('SIGTERM');
  await sleep(3500);
  check('the daemon stopped', !alive(daemon.pid) || daemon.exitCode !== null);
  check('its session\u2019s group child is gone', !alive(two.pids.plain));
  check('its session\u2019s setsid child is gone', !alive(two.pids.away),
    'a stopped daemon must not leave processes nothing can reach');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
