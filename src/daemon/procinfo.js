import { readlinkSync, readFileSync, readdirSync } from 'node:fs';
import { uptime } from 'node:os';

// Everything here is best-effort inspection of /proc. A session whose process
// exits mid-read just yields null; callers treat that as "unknown", never fatal.

export function cwdOf(pid) {
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

// /proc/<pid>/stat, but comm (field 2) is wrapped in parens and may itself
// contain spaces or parens, so split after the *last* ')'.
function statOf(pid) {
  let raw;
  try {
    raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
  const close = raw.lastIndexOf(')');
  if (close === -1) return null;
  // Fields 3.. of proc(5): state, ppid, pgrp, session, tty_nr, tpgid, ...
  const rest = raw.slice(close + 2).split(' ');
  return {
    state: rest[0],
    ppid: Number(rest[1]),
    pgrp: Number(rest[2]),
    session: Number(rest[3]),
    ttyNr: Number(rest[4]),
    tpgid: Number(rest[5]),
    // Field 22, in clock ticks since the machine booted.
    starttime: Number(rest[19]),
  };
}

// The kernel counts a process's age in clock ticks, and USER_HZ has been 100 on
// Linux for as long as anyone can remember.
const TICKS_PER_SECOND = 100;

/**
 * When a process started, as a wall-clock time.
 *
 * Good to about a second, which is uptime()'s resolution — plenty for telling a
 * file written by this process from one left behind by its predecessor.
 */
export function startedAt(pid) {
  const st = statOf(pid);
  if (!st || !Number.isFinite(st.starttime)) return null;
  const bootedAt = Date.now() - uptime() * 1000;
  return Math.round(bootedAt + (st.starttime / TICKS_PER_SECOND) * 1000);
}

/**
 * A process's own environment, as it was at exec.
 *
 * Worth having because it is not the daemon's: clio is started by a desktop
 * launcher and knows nothing of what a person exports in their shell profile,
 * while the program running in their tab was started by that shell and does.
 */
export function environOf(pid) {
  try {
    const env = {};
    for (const entry of readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
      const at = entry.indexOf('=');
      if (at > 0) env[entry.slice(0, at)] = entry.slice(at + 1);
    }
    return env;
  } catch {
    return {};
  }
}

function exeOf(pid) {
  try {
    return readlinkSync(`/proc/${pid}/exe`);
  } catch {
    return null;
  }
}

function cmdlineOf(pid) {
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    const parts = raw.split('\0').filter(Boolean);
    return parts.length ? parts : null;
  } catch {
    return null;
  }
}

function childrenOf(pid) {
  try {
    const raw = readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim();
    return raw ? raw.split(/\s+/).map(Number) : [];
  } catch {
    return [];
  }
}

/**
 * The environments of a process's own children.
 *
 * Worth having for the thing a process cannot say about itself. An environment
 * is fixed at exec, so anything a program works out about itself afterwards —
 * an id it generated, a port it bound — is missing from its own, and present in
 * the environment of everything it has started since. See SESSION_ENV in
 * src/agents/claude.js, which is how a conversation's id is proved to belong to
 * one tab rather than guessed from the timestamps in a directory that every tab
 * in a repository writes into.
 *
 * Direct children only, and not the tree below them: a grandchild is as likely
 * to be a nested agent of its own — a tool shell that ran `claude` — and that
 * one's conversation is not this tab's. Each read is a few kilobytes and this
 * is asked once per capture, which is once every few seconds per tab.
 */
export function childEnvirons(pid) {
  return childrenOf(pid).map((child) => environOf(child));
}

/**
 * The command currently in the foreground of this pty, or null when the shell
 * itself is at the prompt.
 *
 * The kernel tracks which process group owns the terminal (tpgid). If that
 * differs from the shell's own process group, some job has the terminal — walk
 * the shell's descendants to find whoever is in that group.
 */
export function foregroundCommand(shellPid) {
  const shell = statOf(shellPid);
  if (!shell) return null;
  if (shell.tpgid <= 0 || shell.tpgid === shell.pgrp) return null;

  const seen = new Set();
  const queue = childrenOf(shellPid);
  while (queue.length) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);

    const st = statOf(pid);
    if (st && st.pgrp === shell.tpgid) {
      const argv = cmdlineOf(pid);
      if (argv) return { pid, argv, exe: exeOf(pid) };
    }
    queue.push(...childrenOf(pid));
  }
  return null;
}

/**
 * Everything still running under a tab that is about to be rebuilt.
 *
 * A shell should die with the daemon that was holding its pty: the master
 * closes, the terminal hangs up, and the kernel sends SIGHUP. That is not what
 * happens. A pty master is an ordinary file descriptor and every child of a
 * shell inherits it, so anything long-lived that a tab ever started — an MCP
 * server behind an agent, another agent's daemon, a `nohup`ed job — goes on
 * holding the master of the tab it was born in, and of every tab opened before
 * it. Nothing hangs up. The shell survives with its whole tree, unreachable:
 * no terminal on it, nobody able to read or write it, and still holding the
 * port forward the tab is about to ask for again.
 *
 * So a daemon rebuilding tabs from disk clears out the ones from the last life
 * first. Every shell clio starts carries CLIO_SESSION, children inherit it, and
 * that mark plus a tab id this daemon is restoring is enough to be sure: the
 * shell it belonged to is gone, whatever answers to it is debris.
 *
 * Only ever called on the restore path. A handover keeps its shells and must
 * never come near this.
 */
export function markedProcesses(sessionIds) {
  const wanted = sessionIds instanceof Set ? sessionIds : new Set(sessionIds);
  if (!wanted.size) return [];

  let entries;
  try {
    entries = readdirSync('/proc');
  } catch {
    return [];
  }

  const found = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    let raw;
    try {
      raw = readFileSync(`/proc/${pid}/environ`, 'utf8');
    } catch {
      continue; // somebody else's, or it exited while we looked
    }
    const at = raw.indexOf('CLIO_SESSION=');
    if (at === -1) continue;
    const id = raw.slice(at + 'CLIO_SESSION='.length).split('\0')[0];
    if (wanted.has(id)) found.push({ pid, session: id });
  }
  return found;
}

export function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}
