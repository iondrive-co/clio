import { execFile } from 'node:child_process';

import { onPath } from './window.js';

const TOOL_TIMEOUT_MS = 3000;

const LOOK_ATTEMPTS = 8;
const LOOK_WAIT_MS = 150;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(program, args, env) {
  return new Promise((resolve) => {
    execFile(
      program,
      args,
      { env, timeout: TOOL_TIMEOUT_MS, encoding: 'utf8', windowsHide: true },
      (err, stdout) => resolve(err ? null : stdout),
    );
  });
}

async function wmctrlFind(program, mark, env) {
  const out = await run(program, ['-l'], env);
  if (out === null) return null;
  for (const line of out.split('\n')) {
    const fields = /^(0x[0-9a-fA-F]+)\s+\S+\s+\S+ (.*)$/.exec(line.trimEnd());
    if (fields && fields[2] === mark) return fields[1];
  }
  return null;
}

function wmctrlMove(program, id, { x, y, width, height }, env) {
  return run(program, ['-i', '-r', id, '-e', `0,${x},${y},${width},${height}`], env);
}

async function wmctrlDesktop(program, env) {
  const out = await run(program, ['-d'], env);
  const size = /\bDG:\s*(\d+)x(\d+)/.exec(String(out || ''));
  return size ? { width: Number(size[1]), height: Number(size[2]) } : null;
}

function literal(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function xdotoolFind(program, mark, env) {
  const out = await run(program, ['search', '--name', `^${literal(mark)}$`], env);
  const ids = String(out || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return ids.length === 1 ? ids[0] : null;
}

async function xdotoolMove(program, id, { x, y, width, height }, env) {
  const sized = await run(program, ['windowsize', id, String(width), String(height)], env);
  if (sized === null) return null;
  return run(program, ['windowmove', id, String(x), String(y)], env);
}

async function xdotoolDesktop(program, env) {
  const out = await run(program, ['getdisplaygeometry'], env);
  const size = /^(\d+)\s+(\d+)/.exec(String(out || '').trim());
  return size ? { width: Number(size[1]), height: Number(size[2]) } : null;
}

export function windowPlacer(env = process.env) {
  const wmctrl = onPath('wmctrl', env);
  if (wmctrl) {
    return {
      name: 'wmctrl',
      find: (mark) => wmctrlFind(wmctrl, mark, env),
      move: (id, geometry) => wmctrlMove(wmctrl, id, geometry, env),
      desktop: () => wmctrlDesktop(wmctrl, env),
    };
  }
  const xdotool = onPath('xdotool', env);
  if (xdotool) {
    return {
      name: 'xdotool',
      find: (mark) => xdotoolFind(xdotool, mark, env),
      move: (id, geometry) => xdotoolMove(xdotool, id, geometry, env),
      desktop: () => xdotoolDesktop(xdotool, env),
    };
  }
  return null;
}

function onDesktop({ x, y }, desktop) {
  return x >= 0 && y >= 0 && x < desktop.width && y < desktop.height;
}

export async function placeWindow(mark, geometry, env = process.env) {
  const placer = windowPlacer(env);
  if (!placer) {
    return {
      moved: false,
      install: true,
      why: 'a browser will not move a window between monitors, and nothing here can do it from outside',
    };
  }

  const desktop = await placer.desktop();
  if (desktop && !onDesktop(geometry, desktop)) {
    return {
      moved: false,
      why:
        `${geometry.x},${geometry.y} is not on a desktop that is ${desktop.width}x${desktop.height} ` +
        'now — the monitor it was on has gone. The position is kept for when it comes back',
    };
  }

  for (let attempt = 1; attempt <= LOOK_ATTEMPTS; attempt++) {
    const id = await placer.find(mark);
    if (id) {
      const moved = await placer.move(id, geometry);
      return moved === null
        ? { moved: false, why: `${placer.name} would not move it` }
        : { moved: true, tool: placer.name };
    }
    if (attempt < LOOK_ATTEMPTS) await sleep(LOOK_WAIT_MS);
  }
  return { moved: false, why: 'no window by that name was on the desktop to move' };
}
