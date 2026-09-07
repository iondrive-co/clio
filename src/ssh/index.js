
const TAKES_VALUE = 'BbcDEeFIiJLlmOoPpQRSWw';
const FLAGS = '46AaCfGgKkMNnqsTtVvXxYy';

const NOT_A_SESSION = 'OGQV';

function base(path) {
  const parts = String(path || '').split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

function destinationOf(argv) {
  const words = argv.slice(1);
  let i = 0;

  while (i < words.length) {
    const word = words[i];
    if (word === '--') {
      i++;
      break;
    }
    if (word === '-' || !word.startsWith('-')) break;

    let takesNext = false;
    const letters = word.slice(1);
    for (let c = 0; c < letters.length; c++) {
      const letter = letters[c];
      if (NOT_A_SESSION.includes(letter)) return null;
      if (TAKES_VALUE.includes(letter)) {
        takesNext = c === letters.length - 1;
        break;
      }
      if (!FLAGS.includes(letter)) return null;
    }
    i += takesNext ? 2 : 1;
  }

  if (i >= words.length) return null;
  return { destination: words[i], remote: words.slice(i + 1) };
}

function split(destination) {
  let rest = String(destination);

  const uri = /^ssh:\/\//i.test(rest);
  if (uri) {
    rest = rest.slice('ssh://'.length);
    const slash = rest.indexOf('/');
    if (slash !== -1) rest = rest.slice(0, slash);
  }

  const at = rest.lastIndexOf('@');
  const user = at === -1 ? null : rest.slice(0, at) || null;
  let host = at === -1 ? rest : rest.slice(at + 1);

  const bracketed = /^\[([^\]]*)\](?::\d+)?$/.exec(host);
  if (bracketed) {
    host = bracketed[1];
  } else if (uri) {
    const colon = host.lastIndexOf(':');
    if (colon !== -1 && /^\d+$/.test(host.slice(colon + 1))) host = host.slice(0, colon);
  }

  return host ? { host, user } : null;
}

export function readCommand(argv = []) {
  const found = destinationOf(argv);
  if (!found) return null;
  const parts = split(found.destination);
  if (!parts) return null;
  return { ...parts, remote: found.remote };
}

const ssh = {
  id: 'ssh',
  name: 'ssh',

  matches({ argv = [], exe = null }) {
    if (base(argv[0]) !== 'ssh' && base(exe) !== 'ssh') return false;
    return !!readCommand(argv);
  },

  capture({ argv = [], previous = null }) {
    const found = readCommand(argv);
    if (!found) return previous;
    return {
      v: 1,
      host: found.host,
      user: found.user,
      argv: [...argv],
      remote: found.remote.length > 0,
    };
  },

  resume(state) {
    if (!state?.argv?.length || !state.host) return null;

    const where = state.user ? `${state.user}@${state.host}` : state.host;
    if (state.remote) {
      return {
        argv: state.argv,
        why: `this was running against ${where} — at the prompt, not run`,
        run: false,
      };
    }
    return { argv: state.argv, why: `reconnecting to ${where}`, run: true, alone: true };
  },

  title(state) {
    return state?.host || null;
  },

  describe(state) {
    if (!state?.host) return 'an ssh session';
    return `an ssh session to ${state.user ? `${state.user}@${state.host}` : state.host}`;
  },
};

export default [ssh];
