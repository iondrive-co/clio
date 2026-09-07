
import { readdirSync, statSync, fstatSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TERMINAL = 'cli';

const SESSION_ENV = 'CLAUDE_CODE_SESSION_ID';

const HEAD_BYTES = 64 * 1024;

const TAIL_BYTES = 64 * 1024;

const SPINNER = new Set(['◐', '◑', '◒', '◓']);

const WAITING_STILL_MS = 1500;

const CLOCK_SLACK_MS = 5000;

function base(path) {
  const parts = String(path || '').split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

function configDir(env) {
  return env?.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

function projectDir(cwd, env) {
  if (!cwd) return null;
  const root = join(configDir(env), 'projects');
  const slugs = [cwd.replace(/[^a-zA-Z0-9]/g, '-'), cwd.replace(/\//g, '-')];
  for (const slug of slugs) {
    const dir = join(root, slug);
    if (existsSync(dir)) return dir;
  }
  return null;
}

function transcripts(dir, since) {
  const found = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue;
    const id = name.slice(0, -'.jsonl'.length);
    if (!SESSION_ID.test(id)) continue;
    try {
      const { mtimeMs } = statSync(join(dir, name));
      if (mtimeMs >= since) found.push({ id, mtimeMs });
    } catch {
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function writtenBy(file) {
  let fd = null;
  try {
    fd = openSync(file, 'r');
    const buffer = Buffer.allocUnsafe(HEAD_BYTES);
    const read = readSync(fd, buffer, 0, HEAD_BYTES, 0);
    const lines = buffer.toString('utf8', 0, read).split('\n');
    if (read === HEAD_BYTES) lines.pop();
    for (const line of lines) {
      if (!line.includes('"entrypoint"')) continue;
      try {
        const entry = JSON.parse(line);
        if (typeof entry?.entrypoint === 'string') return entry.entrypoint;
      } catch {
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function conversationName(file) {
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
      if (!line.includes('"ai-title"')) continue;
      try {
        const entry = JSON.parse(line);
        if (typeof entry?.aiTitle === 'string' && entry.aiTitle.trim()) name = entry.aiTitle.trim();
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

function spoken(title) {
  const text = String(title || '').trim();
  if (!text) return null;
  const [first] = [...text];
  const rest = /[\p{L}\p{N}]/u.test(first) ? text : text.slice(first.length).trim();
  return rest || null;
}

function inATerminal(dir, id) {
  const by = writtenBy(join(dir, `${id}.jsonl`));
  return by === null || by === TERMINAL;
}

function resumeArgument(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--resume' || arg === '-r') {
      const next = argv[i + 1];
      if (next && SESSION_ID.test(next)) return next;
    }
    const inline = /^--resume=(.+)$/.exec(arg);
    if (inline && SESSION_ID.test(inline[1])) return inline[1];
  }
  return null;
}

function ownedBy(argv, children) {
  const owned = new Set();
  const asked = resumeArgument(argv);
  if (asked) owned.add(asked);
  for (const env of children) {
    const id = env?.[SESSION_ENV];
    if (id && SESSION_ID.test(id)) owned.add(id);
  }
  return owned;
}

function isClaude(argv = [], exe = null) {
  if (argv.some((arg) => arg === '-p' || arg === '--print')) return false;

  const first = base(argv[0]);
  if (first === 'claude' || base(exe) === 'claude') return true;

  if (first.startsWith('node') || base(exe).startsWith('node')) {
    return argv.slice(1).some((arg) => /claude[^/]*\/cli\.js$/.test(arg) || base(arg) === 'claude');
  }
  return false;
}

export default {
  id: 'claude',
  name: 'Claude Code',

  matches({ argv = [], exe = null }) {
    return isClaude(argv, exe);
  },

  identify(state) {
    return state?.sessionId || null;
  },

  activity(state, { termTitle = null, titleAt = 0, now = Date.now() } = {}) {
    if (!termTitle) return null;
    if (SPINNER.has([...termTitle][0])) return 'working';
    return now - titleAt >= WAITING_STILL_MS ? 'waiting' : null;
  },

  capture({
    argv = [],
    cwd = null,
    startedAt = 0,
    env = null,
    children = [],
    title = null,
    previous = null,
    taken = new Set(),
  }) {
    const dir = projectDir(cwd, env);
    const mine = previous?.sessionId || null;
    const owned = ownedBy(argv, children);
    const named = spoken(title);

    if (dir) {
      const since = Math.max(0, (startedAt || 0) - CLOCK_SLACK_MS);
      const seen = transcripts(dir, since);

      const proven = seen.find((t) => owned.has(t.id));
      if (proven) return { v: 1, sessionId: proven.id, cwd, at: Math.round(proven.mtimeMs) };

      if (named) {
        const answering = seen.filter((t) => conversationName(join(dir, `${t.id}.jsonl`)) === named);
        if (answering.length === 1) {
          const [only] = answering;
          if (taken.has(only.id)) return { v: 1, sessionId: null, cwd, at: null };
          return { v: 1, sessionId: only.id, cwd, at: Math.round(only.mtimeMs) };
        }
      }

      const held = mine && !taken.has(mine) ? seen.find((t) => t.id === mine) : null;
      if (held) return { v: 1, sessionId: held.id, cwd, at: Math.round(held.mtimeMs) };

      const guess = seen.find((t) => !taken.has(t.id) && inATerminal(dir, t.id));
      if (guess) return { v: 1, sessionId: guess.id, cwd, at: Math.round(guess.mtimeMs) };
    }

    const [asked] = owned;
    if (asked) return { v: 1, sessionId: asked, cwd, at: null };

    return previous || { v: 1, sessionId: null, cwd, at: null };
  },

  recover({ command = '', cwd = null }) {
    const words = String(command).trim().split(/\s+/);
    if (!isClaude(words)) return null;

    const asked = resumeArgument(words);
    if (asked) return { v: 1, sessionId: asked, cwd, at: null };

    const dir = projectDir(cwd, null);
    const newest = dir ? transcripts(dir, 0).find((t) => inATerminal(dir, t.id)) : null;
    return newest ? { v: 1, sessionId: newest.id, cwd, at: Math.round(newest.mtimeMs) } : null;
  },

  resume(state, { cwd }) {
    if (state?.sessionId) {
      return {
        argv: ['claude', '--resume', state.sessionId],
        why: 'resuming the Claude Code conversation that was open here',
      };
    }
    return {
      argv: ['claude'],
      why: 'starting Claude Code again — nothing had been said in the conversation that was open here',
      cwd,
    };
  },

  describe(state) {
    return state?.sessionId
      ? `a Claude Code conversation (${state.sessionId.slice(0, 8)})`
      : 'Claude Code';
  },
};
