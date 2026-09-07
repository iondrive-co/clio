import { writeFileSync, readFileSync, renameSync, unlinkSync, readdirSync } from 'node:fs';
import { writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { STATE_FILE, SCROLLBACK_DIR, scrollbackFile } from './paths.js';

const STATE_VERSION = 6;
const READABLE_VERSIONS = new Set([1, 2, 3, 4, 5, 6]);

function atomicWrite(path, data) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}

async function atomicWriteAsync(path, data) {
  const tmp = `${path}.writing`;
  await writeFile(tmp, data, { mode: 0o600 });
  await rename(tmp, path);
}

function stateText(containers, sessions) {
  const occupied = new Set(sessions.map((s) => s.container));
  const payload = {
    version: STATE_VERSION,
    savedAt: Date.now(),
    containers: containers
      .filter((c) => occupied.has(c.id))
      .map((c) => ({
        id: c.id,
        order: c.order,
        name: c.name ?? null,
        named: !!c.named,
        closedAt: c.closedAt ?? null,
        geometry: c.geometry ?? null,
      })),
    sessions: sessions.map((s) => s.toState()),
  };
  return JSON.stringify(payload, null, 2);
}

export function writeState(containers, sessions) {
  try {
    atomicWrite(STATE_FILE, stateText(containers, sessions));
  } catch (err) {
    console.error('[clio] could not save state:', err.message);
  }
}

export function writeStateAsync(containers, sessions) {
  return atomicWriteAsync(STATE_FILE, stateText(containers, sessions));
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

export function writeScrollbackAsync(id, text) {
  return atomicWriteAsync(scrollbackFile(id), text);
}

export function readScrollback(id) {
  try {
    return readFileSync(scrollbackFile(id), 'utf8');
  } catch {
    return '';
  }
}

export function removeScrollback(id) {
  for (const path of [
    scrollbackFile(id),
    `${scrollbackFile(id)}.tmp`,
    `${scrollbackFile(id)}.writing`,
  ]) {
    try {
      unlinkSync(path);
    } catch {
    }
  }
}

export function pruneScrollback(validIds) {
  let files;
  try {
    files = readdirSync(SCROLLBACK_DIR);
  } catch {
    return;
  }
  for (const name of files) {
    const id = name.replace(/\.log(\.tmp|\.writing)?$/, '');
    if (!validIds.has(id)) {
      try {
        unlinkSync(join(SCROLLBACK_DIR, name));
      } catch {
      }
    }
  }
}
