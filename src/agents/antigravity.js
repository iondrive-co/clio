import { readdirSync, readlinkSync, openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PRESENCE_FD = /\/presence\/([0-9a-f-]{36})\.lock$/i;

const CONVERSATION_FD = /\/conversations\/([0-9a-f-]{36})\.db(?:-wal|-shm)?$/i;

const BRAIN_FD = /\/brain\/([0-9a-f-]{36})(?:\/|$)/i;

const NOT_A_SESSION = new Set([
  'agent',
  'agents',
  'changelog',
  'help',
  'install',
  'mcp',
  'mic-serve',
  'models',
  'plugin',
  'plugins',
  'remote-control',
  'update',
]);

function base(path) {
  const parts = String(path || '').split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

function antigravityHome(env) {
  return (
    env?.ANTIGRAVITY_HOME ||
    env?.ANTIGRAVITY_CONFIG_DIR ||
    env?.GEMINI_DIR ||
    process.env.ANTIGRAVITY_HOME ||
    process.env.ANTIGRAVITY_CONFIG_DIR ||
    process.env.GEMINI_DIR ||
    join(homedir(), '.gemini', 'antigravity-cli')
  );
}

function isAntigravityItself(word) {
  const b = base(word);
  return b === 'agy' || b === 'antigravity';
}

function antigravityIn(argv = [], exe = null) {
  if (!argv.length && !exe) return null;
  if (argv.length && (isAntigravityItself(argv[0]) || isAntigravityItself(exe))) {
    return { lead: [argv[0]], args: argv.slice(1) };
  }
  if (
    argv.length &&
    (base(argv[0]).startsWith('node') ||
      base(argv[0]).startsWith('python') ||
      base(exe).startsWith('node') ||
      base(exe).startsWith('python'))
  ) {
    const at = argv.findIndex((word, i) => i > 0 && isAntigravityItself(word));
    if (at !== -1) {
      return { lead: argv.slice(0, at + 1), args: argv.slice(at + 1) };
    }
  }
  if (isAntigravityItself(exe)) {
    return { lead: [argv[0] || 'agy'], args: argv.slice(1) };
  }
  return null;
}

function isAntigravity(argv = [], exe = null) {
  const found = antigravityIn(argv, exe);
  if (!found) return false;
  if (found.args.some((arg) => arg === '-p' || arg === '--print' || arg === '--prompt')) {
    return false;
  }
  for (const word of found.args) {
    if (word.startsWith('-')) continue;
    return !NOT_A_SESSION.has(word);
  }
  return true;
}

function conversationOf(pid) {
  if (!pid) return null;

  let entries;
  try {
    entries = readdirSync(`/proc/${pid}/fd`);
  } catch {
    return null;
  }

  let best = null;
  for (const entry of entries) {
    const fd = Number(entry);
    if (!Number.isFinite(fd)) continue;
    let target;
    try {
      target = readlinkSync(`/proc/${pid}/fd/${entry}`);
    } catch {
      continue;
    }
    for (const pattern of [PRESENCE_FD, CONVERSATION_FD, BRAIN_FD]) {
      const found = pattern.exec(target);
      if (!found || !CONVERSATION_ID.test(found[1])) continue;
      if (!best || fd > best.fd) {
        best = { fd, id: found[1] };
      }
    }
  }

  return best?.id || null;
}

function conversationTitle(home, id) {
  if (!id) return null;
  const file = join(home, 'annotations', `${id}.pbtxt`);
  let fd = null;
  try {
    fd = openSync(file, 'r');
    const { size } = fstatSync(fd);
    const buffer = Buffer.allocUnsafe(Math.min(size, 4096));
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.toString('utf8', 0, read);
    const match = /title:\s*(?:"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)')/.exec(text);
    if (match) {
      const raw = match[1] ?? match[2];
      const title = raw.replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, '\\').trim();
      if (title) return title;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function conversationArgument(argv) {
  const args = antigravityIn(argv)?.args ?? argv.slice(1);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--conversation') {
      const next = args[i + 1];
      if (next && CONVERSATION_ID.test(next)) return next;
    }
    const inline = /^--conversation=(.+)$/.exec(arg);
    if (inline && CONVERSATION_ID.test(inline[1])) return inline[1];
  }
  return null;
}

function withoutTheConversationAsked(args, replaced) {
  const kept = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--conversation') {
      if (i + 1 < args.length && CONVERSATION_ID.test(args[i + 1])) {
        i++;
        continue;
      }
      continue;
    }
    if (arg.startsWith('--conversation=')) continue;
    if (replaced && (arg === '-c' || arg === '--continue')) continue;
    kept.push(arg);
  }
  return kept;
}

export default {
  id: 'antigravity',
  name: 'Antigravity',

  matches({ argv = [], exe = null }) {
    return isAntigravity(argv, exe);
  },

  identify(state) {
    return state?.conversationId || null;
  },

  capture({ pid = null, argv = [], cwd = null, env = null, previous = null }) {
    const held = conversationOf(pid) || conversationArgument(argv);
    const conversationId = held || previous?.conversationId || null;
    const named = conversationId ? conversationTitle(antigravityHome(env), conversationId) : null;
    const name = named || (previous?.conversationId === conversationId ? previous?.name || null : null);

    return { v: 1, conversationId, name, cwd, argv: [...argv] };
  },

  resume(state, { cwd }) {
    const found = state?.argv?.length ? antigravityIn(state.argv) : null;
    const lead = found?.lead?.length ? found.lead : ['agy'];
    const rest = withoutTheConversationAsked(found?.args ?? [], !!state?.conversationId);

    if (state?.conversationId) {
      return {
        argv: [...lead, '--conversation', state.conversationId, ...rest],
        why: 'resuming the Antigravity session that was open here',
      };
    }
    return {
      argv: [...lead, ...rest],
      why: 'starting Antigravity again — nothing had been said in the session that was open here',
      cwd,
    };
  },

  recover({ command = '', cwd = null }) {
    const words = String(command).trim().split(/\s+/).filter(Boolean);
    if (!isAntigravity(words)) return null;
    const asked = conversationArgument(words);
    return { v: 1, conversationId: asked, name: null, cwd, argv: words };
  },

  title(state) {
    return state?.name || null;
  },

  describe(state) {
    return state?.conversationId
      ? `an Antigravity session (${state.conversationId.slice(0, 8)})`
      : 'Antigravity';
  },
};
