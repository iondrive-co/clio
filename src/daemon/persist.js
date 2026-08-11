import { writeFileSync, readFileSync, renameSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_FILE, SCROLLBACK_DIR, scrollbackFile } from './paths.js';

// 2 added containers — which window each tab belongs to.
// 3 added a name and a closedAt to each: a window that has been closed is kept
//   rather than ended, and has to be told apart from one that was still on
//   screen when the daemon went down. Older files are still read — their
//   windows simply come back as ones that were open, which for a version 2 file
//   is true by definition, since closing a window used to end it.
const STATE_VERSION = 3;
const READABLE_VERSIONS = new Set([1, 2, 3]);

// Write-then-rename so a crash mid-write can never leave a half-parsed state
// file — the restore path is exactly the code that runs after a crash, so it
// cannot depend on a clean shutdown having happened.
function atomicWrite(path, data) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}

export function writeState(containers, sessions) {
  // A container with no tabs is a window with nothing in it; restoring one would
  // put an empty frame on screen.
  const occupied = new Set(sessions.map((s) => s.container));
  const payload = {
    version: STATE_VERSION,
    savedAt: Date.now(),
    containers: containers
      .filter((c) => occupied.has(c.id))
      .map((c) => ({ id: c.id, order: c.order, name: c.name ?? null, closedAt: c.closedAt ?? null })),
    sessions: sessions.map((s) => s.toState()),
  };
  try {
    atomicWrite(STATE_FILE, JSON.stringify(payload, null, 2));
  } catch (err) {
    console.error('[clio] could not save state:', err.message);
  }
}

export function readState() {
  const empty = { containers: [], sessions: [] };
  let raw;
  try {
    raw = readFileSync(STATE_FILE, 'utf8');
  } catch {
    return empty;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!READABLE_VERSIONS.has(parsed.version) || !Array.isArray(parsed.sessions)) {
      return empty;
    }
    return {
      containers: Array.isArray(parsed.containers) ? parsed.containers : [],
      sessions: parsed.sessions,
    };
  } catch {
    console.error('[clio] state file was unreadable; starting fresh');
    return empty;
  }
}

export function writeScrollback(id, text) {
  try {
    atomicWrite(scrollbackFile(id), text);
  } catch (err) {
    console.error(`[clio] could not save scrollback for ${id}:`, err.message);
  }
}

export function readScrollback(id) {
  try {
    return readFileSync(scrollbackFile(id), 'utf8');
  } catch {
    return '';
  }
}

export function removeScrollback(id) {
  for (const path of [scrollbackFile(id), `${scrollbackFile(id)}.tmp`]) {
    try {
      unlinkSync(path);
    } catch {
      /* already gone */
    }
  }
}

/** Drop scrollback for sessions that are no longer in the state file. */
export function pruneScrollback(validIds) {
  let files;
  try {
    files = readdirSync(SCROLLBACK_DIR);
  } catch {
    return;
  }
  for (const name of files) {
    const id = name.replace(/\.log(\.tmp)?$/, '');
    if (!validIds.has(id)) {
      try {
        unlinkSync(join(SCROLLBACK_DIR, name));
      } catch {
        /* ignore */
      }
    }
  }
}
