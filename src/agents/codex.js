import { readdirSync, readlinkSync, openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const LOCK_FD = /thread-writer-locks\/([0-9a-f-]{36})\.lock$/i;

const ROLLOUT_FD = /\/rollout-[^/]*?([0-9a-f-]{36})\.jsonl$/i;

const INDEX = 'session_index.jsonl';

const TAIL_BYTES = 64 * 1024;

// Codex spins the braille frames through the terminal title while it is working,
// the way Claude Code spins ◐◑◒◓ through its own.
const SPINNER = new Set([...'⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏']);

const WAITING_STILL_MS = 1500;

// `codex` with no subcommand is the interactive TUI, and so is `codex resume`.
// Everything else codex can be asked to do is a one-shot that no tab should be
// resumed into.
const NOT_A_SESSION = new Set([
  'agents',
  'exec',
  'e',
  'review',
  'login',
  'logout',
  'mcp',
  'plugin',
  'mcp-server',
  'app-server',
  'remote-control',
  'completion',
  'update',
  'doctor',
  'sandbox',
  'debug',
  'apply',
  'a',
  'queue',
  'archive',
  'delete',
  'migrate-rollouts',
  'unarchive',
]);

function base(path) {
  const parts = String(path || '').split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

function codexHome(env) {
  return env?.CODEX_HOME || process.env.CODEX_HOME || join(homedir(), '.codex');
}

function isCodexItself(word) {
  return base(word) === 'codex' || /codex[^/]*\/(cli|index)\.js$/.test(word);
}

// Splits a command into the words that start codex and the words codex was
// given. Usually the first word is codex itself, but it can be run through node
// — `node .../bin/codex` — and then the words to keep hold of are both of them.
function codexIn(argv = [], exe = null) {
  if (!argv.length) return null;
  if (base(argv[0]) === 'codex' || base(exe) === 'codex') {
    return { lead: [argv[0]], args: argv.slice(1) };
  }
  if (!base(argv[0]).startsWith('node') && !base(exe).startsWith('node')) return null;
  const at = argv.findIndex((word, i) => i > 0 && isCodexItself(word));
  if (at === -1) return null;
  return { lead: argv.slice(0, at + 1), args: argv.slice(at + 1) };
}

function isCodex(argv = [], exe = null) {
  const found = codexIn(argv, exe);
  if (!found) return false;
  for (const word of found.args) {
    if (word.startsWith('-')) continue;
    return !NOT_A_SESSION.has(word);
  }
  return true;
}

// Which thread a codex is in is not a guess: it holds that thread's writer lock
// and its rollout file open for as long as it is the thread on screen, so the
// process's own file descriptors name it. Both are read, because a codex that
// has not written yet may hold only one of them — and the highest descriptor
// wins, so a codex that has kept hold of the thread it was in before `/new`
// is read as being in the one it opened last.
function threadOf(pid) {
  if (!pid) return null;

  let entries;
  try {
    entries = readdirSync(`/proc/${pid}/fd`);
  } catch {
    return null;
  }

  let lock = null;
  let rollout = null;
  for (const entry of entries) {
    const fd = Number(entry);
    if (!Number.isFinite(fd)) continue;
    let target;
    try {
      target = readlinkSync(`/proc/${pid}/fd/${entry}`);
    } catch {
      continue;
    }
    for (const [pattern, best] of [[LOCK_FD, 'lock'], [ROLLOUT_FD, 'rollout']]) {
      const found = pattern.exec(target);
      if (!found || !THREAD_ID.test(found[1])) continue;
      const held = best === 'lock' ? lock : rollout;
      if (held && held.fd > fd) continue;
      if (best === 'lock') lock = { fd, id: found[1] };
      else rollout = { fd, id: found[1] };
    }
  }

  return (lock || rollout)?.id || null;
}

// The name codex gives a thread lands in its session index, one line per naming,
// so the last line for an id is what the thread is called now.
function threadName(home, id) {
  const file = join(home, INDEX);
  let fd = null;
  try {
    fd = openSync(file, 'r');
    const { size } = fstatSync(fd);
    const from = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.allocUnsafe(Math.min(size, TAIL_BYTES));
    const read = readSync(fd, buffer, 0, buffer.length, from);
    const lines = buffer.toString('utf8', 0, read).split('\n');
    if (from > 0) lines.shift();
    let name = null;
    for (const line of lines) {
      if (!line.includes(id)) continue;
      try {
        const entry = JSON.parse(line);
        if (entry?.id !== id) continue;
        if (typeof entry.thread_name === 'string' && entry.thread_name.trim()) {
          name = entry.thread_name.trim();
        }
      } catch {
      }
    }
    return name;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function resumeArgument(argv) {
  const args = codexIn(argv)?.args ?? argv.slice(1);
  const words = args.filter((word) => !word.startsWith('-'));
  if (words[0] !== 'resume') return null;
  return words.slice(1).find((word) => THREAD_ID.test(word)) || null;
}

// What a tab was started with is put back as it was, because guessing which of
// codex's options take a value — `-C /tmp`, `-c key=val`, `-m model` — and
// guessing wrong makes a command that will not start. Only the words that name
// *which* thread to open are dropped: an earlier `resume <id>`, and `--last`,
// both of which the thread this tab is in now supersedes.
function withoutTheThreadAsked(words, replaced) {
  const first = words.findIndex((word) => !word.startsWith('-'));
  let kept = [...words];

  if (first !== -1 && words[first] === 'resume') {
    kept.splice(first, 1);
    const id = kept.findIndex((word, i) => i >= first && THREAD_ID.test(word));
    if (id !== -1) kept.splice(id, 1);
  }

  return replaced ? kept.filter((word) => word !== '--last') : kept;
}

export default {
  id: 'codex',
  name: 'Codex',

  matches({ argv = [], exe = null }) {
    return isCodex(argv, exe);
  },

  identify(state) {
    return state?.threadId || null;
  },

  activity(state, { termTitle = null, titleAt = 0, now = Date.now() } = {}) {
    if (!termTitle) return null;
    if (SPINNER.has([...termTitle][0])) return 'working';
    return now - titleAt >= WAITING_STILL_MS ? 'waiting' : null;
  },

  capture({ pid = null, argv = [], cwd = null, env = null, previous = null }) {
    const held = threadOf(pid) || resumeArgument(argv);
    const threadId = held || previous?.threadId || null;
    const named = threadId ? threadName(codexHome(env), threadId) : null;
    const name = named || (previous?.threadId === threadId ? previous?.name || null : null);

    return { v: 1, threadId, name, cwd, argv: [...argv] };
  },

  resume(state, { cwd }) {
    const found = state?.argv?.length ? codexIn(state.argv) : null;
    const lead = found?.lead?.length ? found.lead : ['codex'];
    const rest = withoutTheThreadAsked(found?.args ?? [], !!state?.threadId);

    if (state?.threadId) {
      return {
        argv: [...lead, 'resume', state.threadId, ...rest],
        why: 'resuming the Codex thread that was open here',
      };
    }
    return {
      argv: [...lead, ...rest],
      why: 'starting Codex again — nothing had been said in the thread that was open here',
      cwd,
    };
  },

  recover({ command = '', cwd = null }) {
    const words = String(command).trim().split(/\s+/).filter(Boolean);
    if (!isCodex(words)) return null;
    const asked = resumeArgument(words);
    return { v: 1, threadId: asked, name: null, cwd, argv: words };
  },

  title(state) {
    return state?.name || null;
  },

  describe(state) {
    return state?.threadId
      ? `a Codex thread (${state.threadId.slice(0, 8)})`
      : 'Codex';
  },
};
