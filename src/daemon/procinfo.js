import { readlinkSync, readFileSync } from 'node:fs';

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
  };
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
      if (argv) return { pid, argv };
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
