const fs = require('node:fs');
const fsp = require('node:fs/promises');

const DELAY = Number(process.env.CLIO_SLOW_DISK_MS || 0);
const TARGET = process.env.CLIO_SLOW_DISK_PATH || '';

if (DELAY && TARGET) {
  const mine = (file) => String(file).includes(TARGET);
  const hold = (ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
    }
  };

  const realSync = fs.writeFileSync;
  fs.writeFileSync = function (file, ...rest) {
    if (mine(file)) hold(DELAY);
    return realSync.call(this, file, ...rest);
  };

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
}
