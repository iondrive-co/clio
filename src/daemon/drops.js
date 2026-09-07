import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { basename, extname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { DROPS_DIR } from './paths.js';

const MTIME_SLACK_MS = 2;

const SEARCH_MS = 250;
const SEARCH_ENTRIES = 20000;

const CWD_DEPTH = 5;
const USER_DIR_DEPTH = 3;

const SKIP = new Set(['node_modules', '__pycache__', 'venv', 'target', 'dist', 'build']);

export const MAX_SPOOL_BYTES = 50 * 1024 * 1024;

const SPOOL_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

function matches(path, item) {
  let st;
  try {
    st = statSync(path);
  } catch {
    return false;
  }
  if (item.dir ? !st.isDirectory() : !st.isFile()) return false;
  if (st.size !== item.size) return false;
  return Math.abs(Math.floor(st.mtimeMs) - item.mtime) <= MTIME_SLACK_MS;
}

function search(root, item, maxDepth, budget) {
  const queue = [[root, 0]];

  while (queue.length) {
    if (budget.entries > SEARCH_ENTRIES || Date.now() > budget.until) return null;
    const [dir, depth] = queue.shift();

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      budget.entries++;
      if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.name === item.name && matches(path, item)) return path;
      if (depth < maxDepth && entry.isDirectory()) queue.push([path, depth + 1]);
    }
  }
  return null;
}

function userDirs(home) {
  const dirs = [];
  try {
    const text = readFileSync(join(home, '.config', 'user-dirs.dirs'), 'utf8');
    for (const line of text.split('\n')) {
      const match = /^\s*XDG_[A-Z]+_DIR="(.+)"\s*$/.exec(line);
      if (match) dirs.push(match[1].replace(/^\$HOME/, home));
    }
  } catch {
  }
  for (const name of ['Downloads', 'Desktop', 'Pictures', 'Documents', 'Videos']) {
    dirs.push(join(home, name));
  }
  return dirs;
}

function roots(cwd, home) {
  const out = [];
  const add = (dir, depth) => {
    if (!dir || out.some(([known]) => known === dir)) return;
    out.push([dir, depth]);
  };

  if (cwd && cwd !== home) add(cwd, CWD_DEPTH);
  for (const dir of userDirs(home)) add(dir, USER_DIR_DEPTH);
  add(home, 0);
  return out;
}

export function searchBudget() {
  return { entries: 0, until: Date.now() + SEARCH_MS };
}

export function locate(item, { cwd = null, home = homedir(), budget = searchBudget() } = {}) {
  if (!item?.name || !Number.isFinite(item.size) || !Number.isFinite(item.mtime)) return null;

  for (const [root, depth] of roots(cwd, home)) {
    let ok = false;
    try {
      ok = statSync(root).isDirectory();
    } catch {
    }
    if (!ok) continue;

    const found = search(root, item, depth, budget);
    if (found) return found;
  }
  return null;
}

function safeName(raw) {
  const base = basename(String(raw ?? ''))
    .replace(/[\u0000-\u001f\u007f/\\]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  if (!base) return 'dropped-file';
  if (base.length <= 80) return base;
  const ext = extname(base).slice(0, 16);
  return base.slice(0, 80 - ext.length) + ext;
}

function sameBytes(path, bytes) {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size !== bytes.length) return false;
    return readFileSync(path).equals(bytes);
  } catch {
    return false;
  }
}

function prune(now = Date.now()) {
  let entries;
  try {
    entries = readdirSync(DROPS_DIR, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(DROPS_DIR, entry.name);
    try {
      if (now - statSync(path).mtimeMs > SPOOL_KEEP_MS) unlinkSync(path);
    } catch {
    }
  }
}

export function spool(name, bytes) {
  mkdirSync(DROPS_DIR, { recursive: true, mode: 0o700 });
  prune();

  const safe = safeName(name);
  const ext = extname(safe);
  const stem = safe.slice(0, safe.length - ext.length);

  for (let n = 1; n <= 99; n++) {
    const path = join(DROPS_DIR, n === 1 ? safe : `${stem}-${n}${ext}`);
    if (!existsSync(path)) {
      writeFileSync(path, bytes, { mode: 0o600 });
      return path;
    }
    if (sameBytes(path, bytes)) {
      try {
        const now = new Date();
        utimesSync(path, now, now);
      } catch {
      }
      return path;
    }
  }

  const path = join(DROPS_DIR, `${stem}-${randomBytes(4).toString('hex')}${ext}`);
  writeFileSync(path, bytes, { mode: 0o600 });
  return path;
}

const PLAIN = /^[A-Za-z0-9_@%+=:,./-]+$/;

export function quote(path) {
  return PLAIN.test(path) ? path : `'${path.split("'").join(`'\\''`)}'`;
}
