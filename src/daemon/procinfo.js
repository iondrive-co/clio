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

/** The first descendant of a shell running in a particular process group. */
function inGroup(shellPid, pgrp) {
  const seen = new Set();
  const queue = childrenOf(shellPid);
  while (queue.length) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);

    const st = statOf(pid);
    if (st && st.pgrp === pgrp) {
      const argv = cmdlineOf(pid);
      if (argv) return { pid, argv, exe: exeOf(pid) };
    }
    queue.push(...childrenOf(pid));
  }
  return null;
}

/**
 * The command currently in the foreground of this pty, or null when the shell
 * itself is at the prompt.
 *
 * The kernel tracks which process group owns the terminal (tpgid). If that
 * differs from the shell's own process group, some job has the terminal — walk
 * the shell's descendants to find whoever is in that group.
 *
 * This is the question "what is running in this tab", and it is asked of a
 * shell that has been up for a while and has a job in front of it. It is *not*
 * the question "is this shell free to be typed at" — see somethingInFront,
 * which is that one and is not the same question at all.
 */
export function foregroundCommand(shellPid) {
  const shell = statOf(shellPid);
  if (!shell) return null;
  if (shell.tpgid <= 0 || shell.tpgid === shell.pgrp) return null;
  return inGroup(shellPid, shell.tpgid);
}

/**
 * Is anything in front of this shell — a job it is waiting on, or a command in
 * its own startup files?
 *
 * The second half is why this exists, and it is a correction. A shell only puts
 * a job into a process group of its own once job control is on, and bash turns
 * job control on *after* it has finished running its startup files. So for the
 * whole of ~/.bashrc — every command in it, `keychain` included — the children
 * it forks stay in the shell's own process group, tpgid never moves off pgrp,
 * and foregroundCommand above sees nothing at all. Measured on this machine: a
 * shell running its profile reports "at its own prompt" for every millisecond
 * of it, and starts answering truthfully only once a person types something.
 *
 * What that cost is the whole of the 24 August restore. Sixty-two tabs came
 * back at 21:22:42 — every one of them in the same second, because the lead
 * that is supposed to hold the rest behind the first shell asked this question,
 * was told the first shell was at its prompt a quarter of a second after it
 * started, and let go. Sixty-two profiles then ran `keychain` at once against
 * an agent that had nothing in it: forty-one of them were still sitting on
 * `Enter passphrase for /home/miles/.ssh/id_rsa:` ten minutes later. And
 * because each tab's resume was typed into a shell still inside its profile,
 * the line went into the terminal's buffer and `ssh-add` read it as the
 * passphrase — so `bash scripts/ainun-dashboard-agent.sh` was offered to a key
 * as its password, and nothing was resumed at all.
 *
 * So the process group is asked about twice. A job that has taken the terminal
 * is the ordinary case and tpgid finds it. Anything still running in the
 * shell's *own* group is the profile, which has not got as far as job control
 * yet — and a shell in its profile is exactly the shell nothing may be typed
 * into.
 *
 * The one thing this cannot tell from a profile is a background job left in the
 * shell's group by one — `something &` in a .bashrc, which job control would
 * have moved out and, before job control, does not. A tab like that reads as
 * busy until whatever it is exits; the caps in ../daemon/session.js are the
 * backstop, and what they fall back to is the behaviour above.
 */
export function somethingInFront(shellPid) {
  const shell = statOf(shellPid);
  if (!shell) return false;
  if (shell.tpgid > 0 && shell.tpgid !== shell.pgrp) return true;
  return !!inGroup(shellPid, shell.pgrp);
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
