/*
 * Scripts — the thing somebody set running and left running.
 *
 * The two extensions that came before this one earn their place by arguing that
 * bringing something back costs nothing that was not already spent: a
 * conversation is on disk the whole time, a connection is only a connection.
 * A script cannot make that argument. Running it again *is* running it again,
 * and the seam used to say so and stop there — `bash scripts/foo.sh was running
 * here and was not restarted` — which is honest and leaves a dashboard agent
 * that had been looping every five minutes silently not looping.
 *
 * So the argument this one makes is a different one, and it is about what a
 * terminal is for. A script that was in the foreground of a tab when the machine
 * went down is the tab: nobody leaves a build in the foreground of a tab they
 * intend to come back to, they leave the thing that was supposed to keep
 * running. Clio's promise is that the tab comes back the way it was left, and
 * for these tabs the note in the seam was the whole of the failure to keep it.
 *
 * What that costs is real and is not hidden: a deploy caught mid-flight comes
 * back mid-flight. Two things narrow it. The first is the match — see below,
 * this is deliberately not "anything that was in the foreground". The second is
 * `CLIO_RESUME=off`, which is the daemon-wide escape hatch every extension
 * answers to.
 *
 * It knows nothing about clio. See ../extensions/index.js for the contract, and
 * note that this adapter is asked *last*: an agent and an ssh session are both
 * reachable through an interpreter, and both have a better answer than this one.
 */

/*
 * Programs that run a file somebody wrote, rather than being the program.
 *
 * The list is short on purpose. Everything on it has the same shape — the
 * interpreter, then options, then a path — which is what makes the file
 * argument findable, and finding it is the whole of the match.
 */
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

/*
 * Options that mean the words after them are a program rather than a path.
 *
 * `bash -c 'while true; do …; done'` and `python -m http.server` are somebody
 * typing a program at the prompt, not running a file. They are still work, and
 * a person may well want them back, but there is no file to point at and the
 * quoting is the argument's whole meaning — so they are left in the seam, which
 * is where everything this adapter does not claim already goes.
 */
const NOT_A_FILE = new Set(['-c', '--command', '-m', '--module', '-e', '--eval', '-p', '--print']);

/*
 * Extensions that say "this is a script" on their own, for the case where the
 * shebang did the work and there is no interpreter in the argv at all.
 */
const SCRIPT_SUFFIX = /\.(sh|bash|zsh|fish|py|js|mjs|cjs|ts|rb|pl)$/;

function base(path) {
  const parts = String(path || '').split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

/**
 * The file this command line runs, or null if it does not run one.
 *
 * Two shapes, and the line between them and everything else is the point of
 * this function. `bash scripts/foo.sh` names its interpreter and then its file.
 * `./scripts/foo.sh` names the file and lets the shebang find the interpreter —
 * recognised by the path in it, because a bare word is a program on the PATH:
 * `ansible-playbook site.yml` is python running a file too, and re-running
 * somebody's playbook is exactly what this must not do.
 *
 * Anything else — an interactive shell, a REPL, `bash -c`, a program that
 * happens to be written in python — is not a script for these purposes and
 * belongs in the seam.
 */
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
    // An interpreter and no file: an interactive shell, or a REPL. A tab at a
    // nested prompt has nothing in it to bring back.
    return null;
  }

  // Launched by path — `./foo.sh`, `scripts/foo`, `/home/me/bin/watch`. The
  // slash is what separates it from a program that lives on the PATH.
  if (first.includes('/')) return first;

  // A bare word with a script's suffix is one too: `foo.sh` found on the PATH
  // is still a file somebody wrote and put there.
  return SCRIPT_SUFFIX.test(first) ? first : null;
}

const script = {
  id: 'script',
  name: 'a script',

  matches({ argv = [] }) {
    return !!scriptIn(argv);
  },

  /**
   * The whole command line, exactly as it was.
   *
   * The arguments are the run — a script given a different flag is a different
   * thing running — and they are kept verbatim rather than resolved, so what
   * comes back at the prompt is what was typed. Relative paths survive that
   * because the shell is rebuilt in the directory the tab was in.
   */
  capture({ argv = [], cwd = null, previous = null }) {
    const file = scriptIn(argv);
    if (!file) return previous;
    return { v: 1, file, argv: [...argv], cwd };
  },

  /**
   * Which script was in a tab whose record did not survive.
   *
   * Unlike the guess ../agents has to make, there is nothing to guess: the
   * command line is the whole of what this adapter ever knew, and the daemon
   * kept it. Reached for a tab held by a daemon older than this file.
   */
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
