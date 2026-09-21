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

/** Every descendant of [root], deepest last, read out of /proc in one pass. */
export function descendantsOf(root) {
  const children = new Map();
  let entries;
  try {
    entries = readdirSync('/proc');
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    const st = statOf(pid);
    if (!st || !Number.isFinite(st.ppid)) continue;
    if (!children.has(st.ppid)) children.set(st.ppid, []);
    children.get(st.ppid).push(pid);
  }
  const out = [];
  const stack = [root];
  while (stack.length) {
    for (const child of children.get(stack.pop()) || []) {
      out.push(child);
      stack.push(child);
    }
  }
  return out;
}

/** A synchronous pause. Only ever used for the brief grace inside [killTree]. */
function pause(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
  }
}

/**
 * Ends [pid] and everything under it, and returns the pids it signalled.
 *
 * Signalling the shell alone is not enough and was the bug this replaces: a shell that dies hands
 * its children to init, so closing a tab running an agent left that agent alive for days with
 * nothing able to reach it. Three mechanisms, because no one of them covers the ground:
 *
 *  - the process *group*, when the shell leads one — a pty shell does, so this reaches everything
 *    that has not deliberately left it;
 *  - the /proc subtree, captured BEFORE the first signal, which catches a child that called
 *    `setsid` and so is in no group we can name;
 *  - SIGKILL after a short grace, for anything that ignored the first signal.
 *
 * SIGHUP first because that is what a terminal going away means, and a shell — or a CLI with
 * unsaved state — is entitled to act on it.
 *
 * [session] widens the net to every process still carrying that session's `CLIO_SESSION` marker,
 * which is what a `setsid` child needs: it is in no group we can name and no subtree we can walk,
 * because it was reparented to init the moment it detached, but it inherited the environment.
 */
export function killTree(pid, options = {}) {
  const { graceMs = 250, session = null } = options;
  return killTrees([{ pid, session }], { graceMs });
}

/**
 * [killTree] for several trees at once, spending the grace period ONCE rather than per tree.
 *
 * Which matters at shutdown and nowhere else: the grace is a synchronous pause, so doing it per
 * session made stopping a daemon take a quarter-second per open tab. A daemon with a dozen tabs
 * then sat unresponsive for seconds on the way out, long enough for whatever asked it to stop to
 * give up and SIGKILL it — losing the very reaping this is here to do.
 */
export function killTrees(specs, { graceMs = 250 } = {}) {
  const doomed = new Set();
  const groups = new Set();

  for (const { pid = null, session = null } of specs) {
    if (!pid && !session) continue;
    // Captured first: once the signals start landing, the subtree stops being readable.
    if (pid) {
      doomed.add(pid);
      for (const child of descendantsOf(pid)) doomed.add(child);
      // Only when the shell leads its own group — otherwise the negative pid names somebody else's.
      const st = statOf(pid);
      if (st && st.pgrp === pid) groups.add(pid);
    }
    // And by clio's own marker, which is the only thing that reaches a process that called
    // `setsid`: it left the shell's group AND was reparented to init, so neither the group nor the
    // subtree names it any more. `CLIO_SESSION` is inherited through both, so the environment does.
    if (session) for (const { pid: p } of markedProcesses([session])) doomed.add(p);
  }

  doomed.delete(process.pid);
  const all = [...doomed];
  if (!all.length) return [];

  const signal = (sig) => {
    for (const group of groups) {
      try {
        process.kill(-group, sig);
      } catch {
      }
    }
    // Deepest last out of the walk, so signalled in reverse: a parent cannot reap-and-respawn on
    // the way down.
    for (const p of all.slice().reverse()) {
      try {
        process.kill(p, sig);
      } catch {
      }
    }
  };

  signal('SIGHUP');
  if (all.some(isAlive)) {
    pause(graceMs);
    if (all.some(isAlive)) signal('SIGKILL');
  }
  return all;
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
