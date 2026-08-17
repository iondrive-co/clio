/*
 * Files dragged into a window.
 *
 * Every other terminal on the desktop is an X client, so a file dropped on one
 * arrives as text/uri-list and it types the path. That is how an image gets in
 * front of a program running in a terminal, and it is the one thing a terminal
 * that is a web page cannot do: Chrome will not tell the page where a dropped
 * file came from. Measured rather than assumed — a real drag out of a file
 * manager arrives with `dataTransfer.types` of exactly `["Files"]`, with
 * `getData('text/uri-list')` empty, `File.path` absent and
 * `webkitGetAsEntry().fullPath` no more than the basename. A source that also
 * offers the URI as text/plain does not help; Chrome swallows that too.
 *
 * What does arrive is a name, a size, a modification time and the bytes. So the
 * path is worked out here, where the disk is:
 *
 *   locate()  looks for a file that is already on disk and matches all three.
 *             Same test rsync uses to decide a file has not changed, over the
 *             directories a dragged file plausibly came from, so dropping
 *             something from the project you are in or from ~/Downloads types
 *             the real path — the file the person can see, that edits will
 *             land in.
 *
 *   spool()   is for everything else: an image dragged straight out of a
 *             browser, a mail attachment, a file from a disk this daemon cannot
 *             reach. Those have no path to find, so the bytes are written into
 *             a drops directory and that path is typed instead.
 *
 * The two together mean a drop always produces a path that can be read, and
 * produces the *original* path whenever one exists.
 */
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

/** Chrome truncates a file's modification time to whole milliseconds. */
const MTIME_SLACK_MS = 2;

/*
 * A drop is a person waiting with the mouse button still down. The search is
 * bounded so a drop into a home directory with a million files under it types
 * a path from the drops directory promptly instead of hanging the window.
 */
const SEARCH_MS = 250;
const SEARCH_ENTRIES = 20000;

/** How deep to look under the directory the tab is in, and under the rest. */
const CWD_DEPTH = 5;
const USER_DIR_DEPTH = 3;

/* Big, slow, and never where a dragged file came from. Hidden directories are
   skipped wholesale, which covers .git, .cache and friends. */
const SKIP = new Set(['node_modules', '__pycache__', 'venv', 'target', 'dist', 'build']);

/** Bytes past which a file with no path on disk is refused rather than copied. */
export const MAX_SPOOL_BYTES = 50 * 1024 * 1024;

/** How long a spooled copy stays around. Long enough to still be talking about
    the image you dropped on Monday; short enough not to be an archive. */
const SPOOL_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Is this the file that was dropped?
 *
 * Name, size and modification time, which is what rsync trusts to decide a file
 * has not changed. Two different files agreeing on all three, under the same
 * name, in a directory somebody just dragged out of, is not a case worth
 * trading the real path away for.
 */
function matches(path, item) {
  let st;
  try {
    st = statSync(path);
  } catch {
    return false; // a broken link, or something that went away mid-search
  }
  if (item.dir ? !st.isDirectory() : !st.isFile()) return false;
  if (st.size !== item.size) return false;
  return Math.abs(Math.floor(st.mtimeMs) - item.mtime) <= MTIME_SLACK_MS;
}

/**
 * Breadth-first, so shallow matches win: a file dropped from the top of a
 * project is found before a copy of it buried in a subdirectory.
 */
function search(root, item, maxDepth, budget) {
  const queue = [[root, 0]];

  while (queue.length) {
    if (budget.entries > SEARCH_ENTRIES || Date.now() > budget.until) return null;
    const [dir, depth] = queue.shift();

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable directory: not being able to look is not an error
    }

    for (const entry of entries) {
      budget.entries++;
      if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.name === item.name && matches(path, item)) return path;
      // isDirectory() is false for a symlink, which is what keeps this from
      // walking in circles.
      if (depth < maxDepth && entry.isDirectory()) queue.push([path, depth + 1]);
    }
  }
  return null;
}

/**
 * The directories a desktop keeps for the user, in their own language.
 *
 * ~/Downloads is Descargas or Téléchargements on plenty of machines, and the
 * file being dropped is very often in one of them.
 */
function userDirs(home) {
  const dirs = [];
  try {
    const text = readFileSync(join(home, '.config', 'user-dirs.dirs'), 'utf8');
    for (const line of text.split('\n')) {
      const match = /^\s*XDG_[A-Z]+_DIR="(.+)"\s*$/.exec(line);
      if (match) dirs.push(match[1].replace(/^\$HOME/, home));
    }
  } catch {
    /* no such file: the defaults below are the whole of it */
  }
  for (const name of ['Downloads', 'Desktop', 'Pictures', 'Documents', 'Videos']) {
    dirs.push(join(home, name));
  }
  return dirs;
}

/**
 * Where a dropped file might be, in the order worth looking.
 *
 * The tab's own directory first: two identical copies of a file is a thing that
 * happens, and the one somebody working in that directory means is the one in
 * it. Home itself is searched to a depth of zero — just the files sitting
 * directly in it — because walking a home directory is walking everything.
 */
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

/**
 * How long looking may take, shared by everything in one drop.
 *
 * Per file it would be per file: twenty of them, none on this disk, and the
 * window waits five seconds to be told so. One budget for the drop means the
 * files at the end of a long one are copied rather than searched for, which is
 * the right way round — a copy is still a path that works.
 */
export function searchBudget() {
  return { entries: 0, until: Date.now() + SEARCH_MS };
}

/**
 * The path a dropped file already has, or null if it is not on this disk.
 *
 * `item` is {name, size, mtime, dir} as the window read it off the drag.
 */
export function locate(item, { cwd = null, home = homedir(), budget = searchBudget() } = {}) {
  if (!item?.name || !Number.isFinite(item.size) || !Number.isFinite(item.mtime)) return null;

  for (const [root, depth] of roots(cwd, home)) {
    let ok = false;
    try {
      ok = statSync(root).isDirectory();
    } catch {
      /* not there */
    }
    if (!ok) continue;

    const found = search(root, item, depth, budget);
    if (found) return found;
  }
  return null;
}

/**
 * A name that cannot be anything but a name.
 *
 * It arrives from the window, and the window got it from a drag: it is the one
 * part of a drop that somebody else chose. Everything that could make it point
 * out of the drops directory comes off here, and a name that was nothing but
 * those characters becomes a plain one.
 */
function safeName(raw) {
  const base = basename(String(raw ?? ''))
    // eslint-disable-next-line no-control-regex
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

/** Copies nobody has mentioned in a week are not worth keeping. */
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
      /* gone already, or not ours to remove */
    }
  }
}

/**
 * Write bytes that have no path on this disk, and say where they went.
 *
 * The same file dropped twice is the same file: an identical copy already
 * there is reused and its timestamp refreshed, so a screenshot dropped into
 * three tabs is one file and stays put for a week from the last time it was
 * used. A *different* file of the same name gets a numbered name beside it,
 * because overwriting the one somebody dropped a minute ago would change what
 * a path already on their screen points at.
 */
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
        /* the copy is still good even if its timestamp will not move */
      }
      return path;
    }
  }

  const path = join(DROPS_DIR, `${stem}-${randomBytes(4).toString('hex')}${ext}`);
  writeFileSync(path, bytes, { mode: 0o600 });
  return path;
}

/*
 * What lands in the terminal is text somebody is about to press Enter on, so
 * anything a shell would read as syntax is quoted. Single quotes, because
 * inside them a shell reads nothing at all.
 */
const PLAIN = /^[A-Za-z0-9_@%+=:,./-]+$/;

export function quote(path) {
  return PLAIN.test(path) ? path : `'${path.split("'").join(`'\\''`)}'`;
}
