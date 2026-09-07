import { readlinkSync, readFileSync, readdirSync } from 'node:fs';
import { uptime } from 'node:os';

export function cwdOf(pid) {
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

function statOf(pid) {
  let raw;
  try {
    raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
  const close = raw.lastIndexOf(')');
  if (close === -1) return null;
  const rest = raw.slice(close + 2).split(' ');
  return {
    state: rest[0],
    ppid: Number(rest[1]),
    pgrp: Number(rest[2]),
    session: Number(rest[3]),
    ttyNr: Number(rest[4]),
    tpgid: Number(rest[5]),
    starttime: Number(rest[19]),
  };
}

const TICKS_PER_SECOND = 100;

export function startedAt(pid) {
  const st = statOf(pid);
  if (!st || !Number.isFinite(st.starttime)) return null;
  const bootedAt = Date.now() - uptime() * 1000;
  return Math.round(bootedAt + (st.starttime / TICKS_PER_SECOND) * 1000);
}

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

export function childEnvirons(pid) {
  return childrenOf(pid).map((child) => environOf(child));
}

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

export function foregroundCommand(shellPid) {
  const shell = statOf(shellPid);
  if (!shell) return null;
  if (shell.tpgid <= 0 || shell.tpgid === shell.pgrp) return null;
  return inGroup(shellPid, shell.tpgid);
}

export function somethingInFront(shellPid) {
  const shell = statOf(shellPid);
  if (!shell) return false;
  if (shell.tpgid > 0 && shell.tpgid !== shell.pgrp) return true;
  return !!inGroup(shellPid, shell.pgrp);
}

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
      continue;
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
