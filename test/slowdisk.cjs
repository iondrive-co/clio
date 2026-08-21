/*
 * A stand-in for a disk that has stopped answering, for test/stall.mjs.
 *
 * Preloaded into a daemon with NODE_OPTIONS=--require. Writes to the path named
 * in CLIO_SLOW_DISK_PATH take CLIO_SLOW_DISK_MS to complete — the synchronous
 * ones by holding on to the thread that called them, which for the daemon is
 * the one thread it has, and the asynchronous ones by not being finished yet.
 * Which is the difference the test is about: the kernel blocks the caller of a
 * write it cannot satisfy, and it matters enormously whether that caller is the
 * event loop or one of libuv's file threads.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');

const DELAY = Number(process.env.CLIO_SLOW_DISK_MS || 0);
const TARGET = process.env.CLIO_SLOW_DISK_PATH || '';

if (DELAY && TARGET) {
  const mine = (file) => String(file).includes(TARGET);
  const hold = (ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      /* the thread that called this is not going anywhere */
    }
  };

  const realSync = fs.writeFileSync;
  fs.writeFileSync = function (file, ...rest) {
    if (mine(file)) hold(DELAY);
    return realSync.call(this, file, ...rest);
  };

  // fs.promises and node:fs/promises are the same object; patch it once.
  const seen = new Set();
  for (const target of [fsp, fs.promises]) {
    if (seen.has(target)) continue;
    seen.add(target);
    const real = target.writeFile;
    target.writeFile = async function (file, ...rest) {
      if (mine(file)) await new Promise((resolve) => setTimeout(resolve, DELAY));
      return real.call(this, file, ...rest);
    };
  }
  // Nothing is printed from here. NODE_OPTIONS reaches every node process the
  // launcher runs, including the ones whose stdout it parses as JSON.
}
