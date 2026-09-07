import * as pty from 'node-pty';
import fs from 'node:fs';
import tty from 'node:tty';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let nativeModule = null;
function native() {
  if (!nativeModule) {
    nativeModule = require('node-pty/lib/utils.js').loadNativeModule('pty').module;
  }
  return nativeModule;
}

export function spawnPty({ file, cwd, cols, rows, env }) {
  const term = pty.spawn(file, [], { name: 'xterm-256color', cols, rows, cwd, env });

  return {
    adopted: false,
    pid: term.pid,
    get fd() {
      return term.fd;
    },
    onData: (cb) => term.onData(cb),
    onExit: (cb) => term.onExit(({ exitCode }) => cb(exitCode)),
    write: (data) => term.write(data),
    resize: (cols2, rows2) => term.resize(cols2, rows2),
    pause: () => term.pause(),
    resume: () => term.resume(),
    kill: () => term.kill(),
  };
}

export function adoptPty({ fd, pid }) {
  const reader = new tty.ReadStream(fd);
  reader.setEncoding('utf8');

  let onData = null;
  let onExit = null;
  let finished = false;

  const finish = () => {
    if (finished) return;
    finished = true;
    if (onExit) onExit(null);
  };

  reader.on('data', (data) => {
    if (onData) onData(data);
  });
  reader.on('error', (err) => {
    if (err.code === 'EAGAIN') return;
    finish();
  });
  reader.on('end', finish);
  reader.on('close', finish);

  const queue = [];
  let pending = null;

  const pump = () => {
    pending = null;
    if (!queue.length || finished) return;
    const task = queue[0];
    fs.write(fd, task.buffer, task.offset, (err, written) => {
      if (err) {
        if (err.code === 'EAGAIN') {
          pending = setImmediate(pump);
          return;
        }
        queue.length = 0;
        return;
      }
      task.offset += written;
      if (task.offset >= task.buffer.byteLength) queue.shift();
      if (queue.length) pending = setImmediate(pump);
    });
  };

  return {
    adopted: true,
    pid,
    fd,
    onData: (cb) => {
      onData = cb;
    },
    onExit: (cb) => {
      onExit = cb;
    },
    write: (data) => {
      const buffer = Buffer.from(data, 'utf8');
      if (!buffer.byteLength || finished) return;
      queue.push({ buffer, offset: 0 });
      if (queue.length === 1 && !pending) pump();
    },
    resize: (cols, rows) => native().resize(fd, cols, rows),
    pause: () => reader.pause(),
    resume: () => reader.resume(),
    kill: () => {
      try {
        process.kill(pid, 'SIGHUP');
      } catch {
      }
      if (pending) clearImmediate(pending);
      queue.length = 0;
      try {
        reader.destroy();
      } catch {
      }
    },
  };
}
