
const INTERPRETERS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'python',
  'python2',
  'python3',
  'node',
  'deno',
  'bun',
  'perl',
  'ruby',
]);

const NOT_A_FILE = new Set(['-c', '--command', '-m', '--module', '-e', '--eval', '-p', '--print']);

const SCRIPT_SUFFIX = /\.(sh|bash|zsh|fish|py|js|mjs|cjs|ts|rb|pl)$/;

function base(path) {
  const parts = String(path || '').split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

export function scriptIn(argv = []) {
  const words = argv.filter((word) => typeof word === 'string');
  if (!words.length) return null;

  const first = words[0];

  if (INTERPRETERS.has(base(first))) {
    for (let i = 1; i < words.length; i++) {
      const word = words[i];
      if (NOT_A_FILE.has(word)) return null;
      if (word === '--') return words[i + 1] || null;
      if (word.startsWith('-')) continue;
      return word;
    }
    return null;
  }

  if (first.includes('/')) return first;

  return SCRIPT_SUFFIX.test(first) ? first : null;
}

const script = {
  id: 'script',
  name: 'a script',

  matches({ argv = [] }) {
    return !!scriptIn(argv);
  },

  capture({ argv = [], cwd = null, previous = null }) {
    const file = scriptIn(argv);
    if (!file) return previous;
    return { v: 1, file, argv: [...argv], cwd };
  },

  recover({ command = '', cwd = null }) {
    const argv = String(command).trim().split(/\s+/).filter(Boolean);
    const file = scriptIn(argv);
    return file ? { v: 1, file, argv, cwd } : null;
  },

  resume(state) {
    if (!state?.argv?.length) return null;
    return {
      argv: state.argv,
      why: `restarting ${state.file || state.argv.join(' ')}`,
      run: true,
    };
  },

  describe(state) {
    return state?.file ? `the script ${state.file}` : 'a script';
  },
};

export default [script];
