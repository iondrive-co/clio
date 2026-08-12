# Agents

An *agent*, here, is a program someone holds a conversation with in a tab —
Claude Code today, whatever else later. This module knows which programs those
are, how to recognise one running in a shell, and what would bring its
conversation back afterwards.

It exists because clio otherwise refuses to re-run anything. A shell that dies
takes a build, a deploy or an ssh session with it, and the daemon names the
command in the seam above the new prompt rather than guessing that you wanted it
back. An agent is the exception that earns itself: the work is the conversation,
the conversation is already on disk, and reopening it executes nothing that was
not executed before.

## The boundary

`src/agents/` imports nothing from `src/daemon/`. It gets plain objects and
returns plain objects. It never touches a pty, a socket or clio's state file,
and — the part that matters — **an adapter never executes anything**. It
describes a command; the daemon decides whether to run it, when, and into which
shell.

That is what makes this safe to break off into a plugin later: a plugin author
writes a file against the contract below and cannot, by writing it, run
anything. Two call sites in the daemon reach this module and no others —
`SessionManager.pollProcInfo`, which observes, and `SessionManager.reopen`,
which resumes.

## The contract

An adapter is a default-exported object:

```js
export default {
  id: 'claude',           // stable; it is written into clio's state file
  name: 'Claude Code',    // for people

  /** Is this foreground process one of mine? */
  matches({ pid, argv, exe, cwd, startedAt, env }),

  /**
   * Everything worth remembering about it, as JSON you own.
   *
   * Called while the process runs, at most every few seconds. `previous` is
   * what you last answered for this same process; `taken` are the identities
   * other tabs have already claimed, so two conversations in one directory do
   * not both get recorded as the same one. Return the previous answer to keep
   * it. Give the object a version field of your own — clio never looks inside.
   */
  capture({ pid, argv, exe, cwd, startedAt, env, previous, taken }),

  /**
   * The command that picks that up again in a fresh shell, or null for
   * nothing worth resuming.
   *
   * `why` completes the sentence clio writes above the new prompt:
   *   ──── new shell 09:41 — <why> ────
   */
  resume(state, { cwd }),   // → { argv: [...], why: '…' } | null

  /** One line naming what a tab is holding. */
  describe(state),
};
```

Then add it to `ADAPTERS` in `index.js`.

### What you can rely on

- `argv` and `exe` come from `/proc`, and `env` is the process's own
  environment, not the daemon's — a daemon started from a desktop launcher has
  nothing your agent's shell profile set.
- `startedAt` is when the process started, in epoch milliseconds. Use it to tell
  today's conversation from a file left in the same directory yesterday.
- `capture` may return `null`; a record with no state is still a record that an
  agent of your kind was running.
- Throwing loses your turn and nothing else. The registry catches it.

### What you must not rely on

- Being called at any particular moment, or for every process that ever runs.
  Observation is a poll, and a process that lives for two seconds may be missed
  entirely.
- The state you saved being the state you get back. It goes through clio's state
  file and may have been written by an older version of your adapter — hence the
  version field, and hence handling its absence.

## Reserved

`status(state, …)` and `title(state)` are not called yet. They are named here so
that the later features — a tab that says whether its agent is working or
waiting for you, a picker that lists conversations rather than shells, a
notification when an agent wants an answer — hang off the same record instead of
growing a second one.
