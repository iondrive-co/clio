import * as pty from 'node-pty';
import fs from 'node:fs';
import tty from 'node:tty';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/*
 * node-pty keeps its binding in build/Release, build/Debug or prebuilds
 * depending on how it was installed, so borrow its own loader rather than
 * guessing a path that happens to be right on this machine.
 *
 * Only resizing needs it: telling a pty its new size is an ioctl on the master,
 * and there is no way to reach one from JavaScript otherwise.
 */
let nativeModule = null;
function native() {
  if (!nativeModule) {
    nativeModule = require('node-pty/lib/utils.js').loadNativeModule('pty').module;
  }
  return nativeModule;
}

/*
 * A pty as the rest of the daemon needs it: something to read, write, resize
 * and end, with a pid attached.
 *
 * There are two kinds. One we started ourselves, and one we inherited from the
 * daemon we replaced — a reload hands the master file descriptors to the
 * successor process, so the shells never learn that the process behind them
 * changed. Both have to behave identically from here up, because after a reload
 * every session in the daemon is the second kind.
 */

/** Start a shell on a new pty. */
export function spawnPty({ file, cwd, cols, rows, env }) {
  const term = pty.spawn(file, [], { name: 'xterm-256color', cols, rows, cwd, env });

  return {
    adopted: false,
    pid: term.pid,
    // Read late: this is the descriptor a reload hands to the next daemon.
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

/**
 * Take over a pty this process did not create, from a master descriptor it was
 * handed at startup.
 *
 * There is no node-pty object to be had here — its own is built around a fork
 * it performed — so the descriptor is driven directly: a tty stream to read,
 * queued writes to avoid blocking on a full kernel buffer, and the binding's
 * resize for SIGWINCH. The shell on the other end cannot tell the difference.
 */
export function adoptPty({ fd, pid }) {
  const reader = new tty.ReadStream(fd);
  reader.setEncoding('utf8');

  let onData = null;
  let onExit = null;
  let finished = false;

  /*
   * The master reports the shell's death as an error, not as an end: once the
   * last slave is closed, reads come back EIO. Anything else that stops the
   * stream means the same thing from our side — nobody is on the other end.
   */
  const finish = () => {
    if (finished) return;
    finished = true;
    // Exit codes belong to the process that waited on the child, and after a
    // reload that process is gone. The tab closes either way.
    if (onExit) onExit(null);
  };

  reader.on('data', (data) => {
    if (onData) onData(data);
  });
  reader.on('error', (err) => {
    // EAGAIN is a pty with nothing to say yet, not a pty that has gone.
    if (err.code === 'EAGAIN') return;
    finish();
  });
  reader.on('end', finish);
  reader.on('close', finish);

  /*
   * Writes go to the descriptor one at a time behind a queue. A pty whose
   * reader is slow fills its kernel buffer and starts refusing writes with
   * EAGAIN; retrying on the next tick keeps typing intact without blocking the
   * event loop, which is how node-pty handles the same problem.
   */
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
        // The pty is gone, or unusable; dropping the queue beats retrying into
        // a descriptor that will never take it.
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
        /* already gone */
      }
      if (pending) clearImmediate(pending);
      queue.length = 0;
      try {
        reader.destroy();
      } catch {
        /* ignore */
      }
    },
  };
}
