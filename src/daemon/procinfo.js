import { readlinkSync, readFileSync } from 'node:fs';
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

export function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}
