/*
 * Extensions — what a tab is holding, and who knows how to bring it back.
 *
 * A tab is a shell, and a shell that dies takes whatever was running in it. For
 * most of what runs in a terminal that is the end of the matter: clio names the
 * command in the seam above the new prompt and leaves it, because re-running a
 * build or a deploy is not a decision to make on somebody's behalf. An
 * extension is an argument that some particular thing is not like that — that
 * bringing it back costs nothing that was not already spent. `src/agents` makes
 * that argument for a conversation, which is on disk the whole time.
 * `src/ssh` makes it for a connection, which is only a connection.
 *
 * This module is the host they plug into. It knows nothing about clio and
 * nothing about ssh or agents: it holds the list, asks each adapter in turn
 * whether a process is one of its own, and turns what comes back into plain
 * data for the daemon.
 *
 * Nothing here or below it imports from ../daemon, touches a pty, or reads
 * clio's state file, and — the part that matters — **an adapter never executes
 * anything**. It describes a command; the daemon decides whether to run it,
 * when, and into which shell. That is what keeps "an extension" from meaning
 * "somebody else's code with a shell", and it is what will let this be a
 * directory somebody drops a file into rather than a list edited here.
 *
 * See README.md for the adapter contract.
 */

import agents from '../agents/index.js';
import ssh from '../ssh/index.js';
import scripts from '../scripts/index.js';

/*
 * Every extension clio ships with, in the order they are asked. A plugin
 * directory would be read here and appended; nothing else — in this module or
 * in the daemon — would have to change, because an adapter is reached only
 * through this list.
 *
 * Order is the tie-break when two adapters would both take a process, so the
 * specific go before the general. It matters now that ../scripts is here: an
 * npm-installed agent is `node …/cli.js` and a script is `node …/anything.js`,
 * so the general one is asked last and gets what the others did not want.
 */
const ADAPTERS = [...agents, ...ssh, ...scripts];

/*
 * How often an adapter is asked to look again at something it has already
 * identified.
 *
 * Capture can go to the filesystem, and the answer rarely changes — an agent's
 * conversation only when somebody starts a new one in a tab that already had
 * one, an ssh session's argv never. The proc poll runs every two seconds and
 * must stay cheap enough that nobody thinks about it.
 */
const CAPTURE_INTERVAL_MS = 8000;

/*
 * How long a resumed thing has to appear before we stop believing in it.
 *
 * After a restore the record describes a process that does not exist yet: the
 * command has been typed into a shell that is still working through its
 * profile. If it never arrives — the agent was uninstalled, the host is not
 * reachable from this network — the record has to go, or the tab would go on
 * offering to resume it forever.
 */
const ADOPT_GRACE_MS = 60000;

/*
 * Separates an adapter's id from an identity of its own; see extensionIdentity.
 * Safe as a plain character because the ids are clio's own and are words, and
 * because what follows is only ever compared as a whole prefix — an identity is
 * free to contain colons of its own.
 */
const SEP = ':';

function adapterFor(record) {
  return record?.kind ? ADAPTERS.find((a) => a.id === record.kind) || null : null;
}

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
 * anything an adapter puts in an argument — a path with a space, a quote, a
 * remote command — has to survive the shell reading it. Plain-looking words are
 * left alone so that what appears at the prompt is what a person would have
 * typed.
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
 * What the daemon knows about one tab's extension, if it has one.
 *
 * `state` is the adapter's own — opaque here and to the daemon, versioned by
 * whoever wrote it, and the only part that is written to disk along with the
 * kind. `pid` is not persisted: it means nothing after a reboot, and a pid the
 * kernel has since handed to somebody else would keep a dead record alive.
 */
export function extensionToState(record) {
  if (!record?.kind) return null;
  return { kind: record.kind, state: record.state ?? null, seenAt: record.seenAt ?? null };
}

export function extensionFromState(saved, { pid = null, resumedAt = null } = {}) {
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
 * The one thing this tab has claimed, as a string nobody else can mistake for
 * their own.
 *
 * Only some adapters have anything to claim — two Claude tabs open in one
 * directory must not both be recorded as the same conversation, while two ssh
 * tabs on one host are simply two connections. The daemon collects these across
 * tabs and hands the set back; it never looks inside one, which is the whole
 * point of it being a string.
 */
export function extensionIdentity(record) {
  const adapter = adapterFor(record);
  if (!adapter?.identify) return null;
  const id = safely(() => adapter.identify(record.state || {}), null);
  return id ? `${adapter.id}${SEP}${id}` : null;
}

/**
 * Look at what is running in a tab and decide what to remember about it.
 *
 * `foreground` is the process that owns the terminal, or null when the shell is
 * sitting at its prompt. `taken` are the identities *other* tabs have claimed.
 * Working out which of them are other tabs is the daemon's job and cannot be
 * done from here: this tab's own claim and the same claim held by the tab next
 * to it are the same string, and only the caller holding both records can tell
 * the difference. Subtracting it here instead — which is what this did until a
 * morning when two tabs came back on the same conversation — means a tab whose
 * claim has already been taken by another one is free to take it straight back,
 * and the pair of them never come apart again.
 *
 * The rule for forgetting is deliberately about the process rather than about
 * the foreground: something that has been suspended, or that has a pager open
 * in front of it, is still what this tab is holding. It stops being one when
 * its process is gone — which is also the moment somebody who typed `exit`
 * meant, and their tab must not resurrect itself after a reboot.
 */
export function observeExtension(record, { foreground = null, taken = new Set(), now = Date.now() } = {}) {
  const adapter = foreground ? ADAPTERS.find((a) => safely(() => a.matches(foreground), false)) : null;

  if (adapter) {
    const known = record?.kind === adapter.id && record.pid === foreground.pid;
    if (known && now - (record.capturedAt || 0) < CAPTURE_INTERVAL_MS) return { record, changed: false };

    const state = safely(
      () =>
        adapter.capture({
          ...foreground,
          previous: known ? record.state : null,
          taken: claims(adapter, taken),
        }),
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
        // Carried across the rebuild rather than started again: the process has
        // not changed, and whether it was last seen working is the one thing
        // observeAttention cannot work out from a single look. Dropping it every
        // capture would mean a tab that stopped in the wrong eight seconds never
        // said so.
        activity: known ? record.activity ?? null : null,
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
 * What this adapter's other tabs have claimed, in its own terms — nothing but
 * its prefix stripped back off.
 *
 * The set arriving here is already everybody else's; see observeExtension for
 * why that subtraction belongs to the caller and not to this.
 */
function claims(adapter, taken) {
  const prefix = `${adapter.id}${SEP}`;
  const claimed = new Set();
  for (const entry of taken) {
    if (entry.startsWith(prefix)) claimed.add(entry.slice(prefix.length));
  }
  return claimed;
}

/**
 * Has this tab stopped and started waiting for the person in front of it?
 *
 * Only some adapters can tell, and only about some things: an agent announces
 * whether it is working, an ssh session has no idea. The ones that can carry an
 * `activity` hook, and it is asked on every poll — the answer is about a running
 * process, not about anything on disk, so it is cheap and it goes stale fast.
 *
 * What comes back is an edge and not a state — `'waiting'` the once, when
 * something that was working has stopped, `'working'` when it picks up again,
 * and null the rest of the time, which is nearly always. That is the whole
 * design of it. A tab rebuilt from disk is holding something that was already
 * at rest before this daemon ever looked at it, and after a reboot that is
 * every agent tab there is; a level would light the entire row up on the way
 * back, which is noise and not news. Nothing is ever said about a thing that
 * has not been seen working first.
 */
export function observeAttention(record, { termTitle = null, titleAt = 0, now = Date.now() } = {}) {
  const adapter = adapterFor(record);
  if (!adapter?.activity) return null;

  const answer = safely(() => adapter.activity(record.state || {}, { termTitle, titleAt, now }), null);
  if ((answer !== 'working' && answer !== 'waiting') || answer === record.activity) return null;

  const was = record.activity;
  record.activity = answer;
  return answer === 'waiting' && was !== 'working' ? null : answer;
}

/**
 * How to bring that back in a fresh shell, or null if there is no sense in
 * trying.
 *
 * `why` is a clause the caller can put straight into the seam it draws above
 * the new shell, because the tab has to say what it is about to do before it
 * does it. `run` is the adapter's nerve: false asks for the command to be left
 * at the prompt for somebody to press Enter on, which is how an adapter says
 * "this is what was here, and I am not the one who should decide it happens
 * again".
 *
 * `alone` is the other thing only an adapter can know: that two of these
 * starting at the same moment get in each other's way. It is the daemon that
 * acts on it — this module starts nothing — and all it promises is that no two
 * resumes of the same kind overlap. See src/ssh, which is the reason it exists.
 */
export function resumeExtension(record, { cwd = null } = {}) {
  const adapter = adapterFor(record);
  if (!adapter) return null;

  const plan = safely(() => adapter.resume(record.state || {}, { cwd }), null);
  if (!plan?.argv?.length) return null;

  return {
    kind: adapter.id,
    command: shellQuote(plan.argv),
    why: plan.why || `resuming ${adapter.name}`,
    run: plan.run !== false,
    alone: plan.alone === true,
  };
}

/**
 * What was in a tab whose record did not survive — worked out from what is on
 * disk, and only ever named, never run.
 *
 * The last line of defence, and it exists because of a real morning: five tabs
 * holding conversations, a daemon that had been running since before the agents
 * extension was written, and a crash. There was no record to resume from, so
 * every one of them came back saying `claude … was running here and was not
 * restarted` — true, and useless, because the one thing needed to get the
 * conversation back was the id, and the id was sitting on the filesystem the
 * whole time.
 *
 * A guess from disk is not good enough to run: it can name yesterday's
 * conversation in the same directory. It is more than good enough to print.
 */
export function recoverExtension({ command = null, cwd = null } = {}) {
  if (!command) return null;
  for (const adapter of ADAPTERS) {
    if (!adapter.recover) continue;
    const state = safely(() => adapter.recover({ command, cwd }), null);
    if (!state) continue;
    const plan = safely(() => adapter.resume(state, { cwd }), null);
    if (!plan?.argv?.length) continue;
    return { kind: adapter.id, command: shellQuote(plan.argv) };
  }
  return null;
}

/** One line naming what a tab is holding, for logs and for the tab itself. */
export function describeExtension(record) {
  const adapter = adapterFor(record);
  if (!adapter) return null;
  return safely(() => adapter.describe(record.state || {}), adapter.name) || adapter.name;
}

/**
 * What this tab should be called, if its extension has a better idea than the
 * directory — an ssh tab named after the host it is on, the way every other
 * terminal does it. Null means no opinion, which is most of the time.
 */
export function extensionTitle(record) {
  const adapter = adapterFor(record);
  if (!adapter?.title) return null;
  const title = safely(() => adapter.title(record.state || {}), null);
  return typeof title === 'string' && title.trim() ? title.trim().slice(0, 80) : null;
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
