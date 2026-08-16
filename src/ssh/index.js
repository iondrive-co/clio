/*
 * ssh — the host a tab was on.
 *
 * For most of clio's life ssh was the standing example of what it would *not*
 * do. A shell that dies takes its ssh session with it, and the daemon named the
 * command in the seam above the new prompt rather than running it again,
 * because re-running what was in a tab is how a terminal starts a build nobody
 * asked for. That was the right instinct aimed at the wrong thing.
 *
 * A connection is not work. `ssh host` says nothing to the far end and changes
 * nothing there: it opens a channel and gives you a login shell on the other
 * side of it. When the daemon dies the channel is already gone — dialling it
 * again is not a decision about somebody's data, it is the tab going back to
 * where it was pointing. That is the argument, and it is the same shape as the
 * one ../agents makes: bringing this back costs nothing that was not already
 * spent.
 *
 * It stops being true the moment there is a command after the destination.
 * `ssh build-01 make deploy` is work, wearing a connection as a coat, and this
 * adapter will not run it. It remembers it, offers it back typed at the prompt,
 * and leaves the Enter to a person — which is the whole of `run: false` in the
 * contract and the reason that flag exists at all.
 *
 * What is remembered is the argv exactly as it was, because the arguments are
 * the session as much as the host is: somebody who left a tunnel open
 *
 *   ssh -o ControlMaster=no -L :9999:localhost:8500 safe@p-fsn-095.example.com
 *
 * has not got their tab back if it comes back without the tunnel.
 *
 * It knows nothing about clio. See ../extensions/README.md for the contract.
 */

/*
 * OpenSSH's option grammar, from ssh(1). Two lists because everything else
 * here depends on telling an option's value from the destination:
 *
 *   ssh -o ControlMaster=no -L :9999:localhost:8500 safe@host
 *                                  ^ not the host    ^ the host
 *
 * A letter that is in neither list is a version of ssh that knows something
 * this does not, and the answer to that is to say so — see destinationOf.
 */
const TAKES_VALUE = 'BbcDEeFIiJLlmOoPpQRSWw';
const FLAGS = '46AaCfGgKkMNnqsTtVvXxYy';

/*
 * Options that mean this ssh is not a session at all: a control command aimed
 * at somebody else's connection (-O), or a question that prints an answer and
 * exits (-G, -Q, -V). None of them holds a terminal for long enough to be worth
 * catching, and a tab that reconnected one of them would be repeating an
 * instruction rather than going back to a host.
 */
const NOT_A_SESSION = 'OGQV';

function base(path) {
  const parts = String(path || '').split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

/**
 * Walk an ssh command line and find where the destination is.
 *
 * Options come first and may cluster (`-tt`, `-NL 9999:localhost:80`), and a
 * clustered value option takes the rest of its own word if there is any and the
 * next word otherwise — `-p22` and `-p 22` are the same thing. The first word
 * that is not an option, and not the value of one, is the destination;
 * everything after it is a command for the far end.
 *
 * Returns null rather than guessing when a letter turns up that is in neither
 * list. Guessing there means mistaking an option's value for the host, and a
 * tab named after a port number is worse than a tab named `ssh`.
 */
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
        // The value is the rest of this word, or all of the next one.
        takesNext = c === letters.length - 1;
        break;
      }
      if (!FLAGS.includes(letter)) return null;
    }
    i += takesNext ? 2 : 1;
  }

  if (i >= words.length) return null; // options and no host: ssh printing its usage
  return { destination: words[i], remote: words.slice(i + 1) };
}

/**
 * Split `[user@]host`, or the ssh:// form of the same thing, into a name for
 * the tab and whoever is logged in there.
 *
 * The user goes to the last `@`, which is what OpenSSH does and what makes
 * `me@work@jump.example.com` resolve the way its author meant. A port can only
 * appear here in the URI form — everywhere else it is `-p` — and it is trimmed
 * off rather than kept: what is wanted is a name, and the argv has the whole
 * command line anyway. An IPv6 literal keeps its brackets out of the name too.
 */
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

/** Everything about one ssh command line, or null if it is not a session. */
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

  /**
   * ssh, and not the several other things whose names start with it.
   *
   * `sshfs`, `ssh-add` and `sshpass` are all their own programs with their own
   * arguments; only the real thing is matched, and only when there is a host in
   * the command line to go back to.
   */
  matches({ argv = [], exe = null }) {
    if (base(argv[0]) !== 'ssh' && base(exe) !== 'ssh') return false;
    return !!readCommand(argv);
  },

  /**
   * The whole command line, and the host read out of it.
   *
   * The argv is what makes this worth keeping: reconnecting to the right
   * machine without the port forward somebody set up is coming back to a
   * different tab from the one they left.
   */
  capture({ argv = [], previous = null }) {
    const found = readCommand(argv);
    if (!found) return previous;
    return {
      v: 1,
      host: found.host,
      user: found.user,
      argv: [...argv],
      // A command for the far end is work, and work is not reconnected. Kept
      // as a flag rather than as the words, which are already in the argv.
      remote: found.remote.length > 0,
    };
  },

  /**
   * Reconnect, with everything it was dialled with the first time.
   *
   * Unless there was a command on the end of it, in which case the tab gets it
   * back at the prompt and somebody else can decide whether it runs again.
   *
   * `alone` is the one thing here that is about the restore rather than about
   * this tab, and it is the difference between one question and six. Almost
   * every ssh config on a desktop has `ControlMaster auto` in it: the first
   * connection to a host builds a socket and every later one rides it for free,
   * bastion included, so a jump host that wants a verification code wants it
   * once. Six connections dialled in the same millisecond all find no socket,
   * all become masters, and all ask — which is what happened on 15 August, when
   * six tabs came back and every one of them stopped on a passphrase or a code,
   * and two of them then lost the race for the socket outright and printed
   * `Connection closed by UNKNOWN port 65535`. Dialled one at a time, only the
   * first is asked anything.
   *
   * Not on the other branch: that one types the command and leaves it, so it
   * dials nothing and there is nothing for it to be in the way of.
   */
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

  /** The tab is on a host, so the tab is called after the host. */
  title(state) {
    return state?.host || null;
  },

  describe(state) {
    if (!state?.host) return 'an ssh session';
    return `an ssh session to ${state.user ? `${state.user}@${state.host}` : state.host}`;
  },
};

export default [ssh];
