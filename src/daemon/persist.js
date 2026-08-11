import { writeFileSync, readFileSync, renameSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_FILE, SCROLLBACK_DIR, scrollbackFile } from './paths.js';

const STATE_VERSION = 1;

// Write-then-rename so a crash mid-write can never leave a half-parsed state
// file — the restore path is exactly the code that runs after a crash, so it
// cannot depend on a clean shutdown having happened.
function atomicWrite(path, data) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}

export function writeState(sessions) {
  const payload = {
    version: STATE_VERSION,
    savedAt: Date.now(),
    sessions: sessions.map((s) => s.toState()),
  };
  try {
    atomicWrite(STATE_FILE, JSON.stringify(payload, null, 2));
  } catch (err) {
    console.error('[clio] could not save state:', err.message);
  }
}

export function readState() {
  let raw;
  try {
    raw = readFileSync(STATE_FILE, 'utf8');
  } catch {
    return { sessions: [] };
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed.version !== STATE_VERSION || !Array.isArray(parsed.sessions)) {
      return { sessions: [] };
    }
    return parsed;
  } catch {
    console.error('[clio] state file was unreadable; starting fresh');
    return { sessions: [] };
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
