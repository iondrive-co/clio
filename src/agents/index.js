/*
 * Agents — the programs people hold a conversation with in a tab.
 *
 * A shell that dies takes a build or an ssh session with it, and clio has
 * always been careful not to guess at bringing those back: a command is named
 * in the seam and left for the user to run again. An agent is different in
 * kind. The work is not the process, it is the conversation the process was
 * showing; the conversation is on disk the whole time, and picking it up again
 * runs nothing that was not already run. So this is the one class of program
 * clio will start for you, and this module is where the knowledge of which
 * programs those are lives.
 *
 * It knows nothing about clio.
 *
 * Nothing here imports from ../daemon, touches a pty, or reads clio's state
 * file. Adapters are handed a description of a process and answer with plain
 * data: what to remember about it, and the argv that would bring it back. They
 * never execute anything — the daemon decides whether, when and how to run what
 * comes back, which is what keeps "an agent plugin" from meaning "somebody
 * else's code with a shell". That boundary is the whole reason this is a
 * directory of its own rather than a few branches in the manager, and it is
 * what lets the module be lifted out into a plugin later without a rewrite.
 *
 * See README.md for the adapter contract.
 */

import claude from './claude.js';

/*
 * Every agent clio knows. A plugin directory would be read here and appended;
 * nothing else in the module — or in the daemon — would have to change, because
 * an adapter is reached only through this list.
 */
const ADAPTERS = [claude];

/*
 * How often an adapter is asked to look again at an agent it has already
 * identified.
 *
 * Capture goes to the filesystem, and the answer only changes when somebody
 * starts a new conversation in a tab that already had one — rare, and no worse
 * than a few seconds stale when it does happen. The proc poll runs every two
 * seconds and must stay cheap enough that nobody thinks about it.
 */
const CAPTURE_INTERVAL_MS = 8000;

/*
 * How long a resumed agent has to appear before we stop believing in it.
 *
 * After a restore the record describes a process that does not exist yet: the
 * command has been typed into a shell that is still working through its profile.
 * If the agent never arrives — it was uninstalled, it is not on this machine's
 * PATH any more — the record has to go, or the tab would offer to resume a
 * conversation forever.
 */
const ADOPT_GRACE_MS = 60000;

/**
 * Is that process still there?
 *
 * Deliberately not imported from the daemon's procinfo, which does the same
 * thing: this module is meant to survive being moved out of this tree, and six
 * lines of node is a cheaper price for that than a dependency.
 */
function running(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function sameState(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Quote an argv into something a shell will read back as the same words.
 *
 * The command is typed into a real shell rather than passed to execve, so
 * anything an adapter puts in an argument — a path with a space, a quote — has
 * to survive the shell reading it. Plain-looking words are left alone so that
 * what appears at the prompt is what a person would have typed.
 */
function shellQuote(argv) {
  return argv
    .map((arg) => {
      const word = String(arg);
      return /^[\w.:/=@,+-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
    })
    .join(' ');
}

/**
 * What the daemon knows about one tab's agent, if it has one.
 *
 * `state` is the adapter's own — opaque here and to the daemon, versioned by
 * whoever wrote it, and the only part that is written to disk along with the
 * kind. `pid` is not persisted: it means nothing after a reboot, and a pid the
 * kernel has since handed to somebody else would keep a dead record alive.
 */
export function agentToState(record) {
  if (!record?.kind) return null;
  return { kind: record.kind, state: record.state ?? null, seenAt: record.seenAt ?? null };
}

export function agentFromState(saved, { pid = null, resumedAt = null } = {}) {
  if (!saved?.kind || !ADAPTERS.some((a) => a.id === saved.kind)) return null;
  return {
    kind: saved.kind,
    state: saved.state ?? null,
    seenAt: saved.seenAt ?? null,
    capturedAt: 0, // unknown: look again at the first opportunity
    pid,
    resumedAt,
  };
}

/**
 * Look at what is running in a tab and decide what to remember about it.
 *
 * `foreground` is the process that owns the terminal, or null when the shell is
 * sitting at its prompt. `taken` are the agent identities other tabs have
 * already claimed, so that two conversations open in one directory are not both
 * recorded as the same one.
 *
 * The rule for forgetting is deliberately about the process rather than about
 * the foreground: an agent that has been suspended, or that has a pager open in
 * front of it, is still an agent this tab is holding. It stops being one when
 * its process is gone — which is also the moment somebody who typed `exit`
 * meant, and their tab must not resurrect itself after a reboot.
 */
export function observeAgent(record, { foreground = null, taken = new Set(), now = Date.now() } = {}) {
  const adapter = foreground ? ADAPTERS.find((a) => safely(() => a.matches(foreground), false)) : null;

  if (adapter) {
    const known = record?.kind === adapter.id && record.pid === foreground.pid;
    if (known && now - (record.capturedAt || 0) < CAPTURE_INTERVAL_MS) return { record, changed: false };

    const state = safely(
      () => adapter.capture({ ...foreground, previous: known ? record.state : null, taken }),
      known ? record.state : null,
    );

    return {
      record: {
        kind: adapter.id,
        state: state ?? null,
        seenAt: now,
        capturedAt: now,
        pid: foreground.pid,
        resumedAt: null,
      },
      changed: !known || !sameState(record.state, state),
    };
  }

  if (!record) return { record: null, changed: false };
  // Alive but not in front: suspended, or busy behind a pager of its own.
  if (record.pid && running(record.pid)) return { record, changed: false };
  // Resumed a moment ago and not yet started. Give it time to arrive.
  if (!record.pid && record.resumedAt && now - record.resumedAt < ADOPT_GRACE_MS) {
    return { record, changed: false };
  }
  return { record: null, changed: true };
}

/**
 * How to bring that agent back in a fresh shell, or null if there is no sense
 * in trying.
 *
 * `why` is a clause the caller can put straight into the seam it draws above
 * the new shell, because the tab has to say what it is about to do before it
 * does it.
 */
export function resumeAgent(record, { cwd = null } = {}) {
  const adapter = ADAPTERS.find((a) => a.id === record?.kind);
  if (!adapter) return null;

  const plan = safely(() => adapter.resume(record.state || {}, { cwd }), null);
  if (!plan?.argv?.length) return null;

  return {
    kind: adapter.id,
    command: shellQuote(plan.argv),
    why: plan.why || `resuming ${adapter.name}`,
  };
}

/** One line naming what a tab is holding, for logs and for the tab itself. */
export function describeAgent(record) {
  const adapter = ADAPTERS.find((a) => a.id === record?.kind);
  if (!adapter) return null;
  return safely(() => adapter.describe(record.state || {}), adapter.name) || adapter.name;
}

/**
 * An adapter that throws is an adapter that has misread something on disk, and
 * that is not a reason to take a terminal down with it. It loses its turn.
 */
function safely(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
