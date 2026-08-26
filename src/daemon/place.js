import { execFile } from 'node:child_process';

import { onPath } from './window.js';

/*
 * Putting a window back where it was, when the window itself cannot.
 *
 * A page moves its own window, and does — see applyGeometry in ../ui/app.js.
 * What it cannot do is move it to another monitor. Chrome answers a moveTo that
 * would take a window off the display it is on by moving it as far as that
 * display allows and stopping there, and the permission that lifts that is not
 * one an app window has any way to ask for. So a desktop whose windows were
 * spread over three monitors comes back with every one of them the size it was,
 * on whichever monitor the browser happened to open it on — which for anybody
 * with more than one screen is most of "as it was" missing.
 *
 * A window manager has no such restriction: putting windows where it is told is
 * the whole of what it does. Nothing in this process can talk to it directly,
 * so this asks through whichever of the two programs everyone already has for
 * it. Neither is required. A desktop with neither, and a Wayland session where
 * none of this reaches anything, gets what it got before: windows the right
 * size, together on one monitor.
 *
 * Which window is which is the only real difficulty. Every clio window is the
 * same browser, the same class and the same process, and the one thing that
 * tells them apart from outside is the title — so the page that needs moving
 * wears a name the daemon chose for it until this is done, and puts its own
 * back afterwards. See placeMark and the 'place' message in ./index.js.
 */

// Long enough for a program that has to open the display and read the window
// list; short enough that a desktop which has wedged does not take the daemon
// with it. Nothing waits on these but the one window being moved.
const TOOL_TIMEOUT_MS = 3000;

// The title is set by the page a moment before it asks, and has to travel
// through the browser to the X server before anything out here can see it.
// Eight looks over a second and a bit: far longer than it takes, and it stops
// at the first one that finds it.
const LOOK_ATTEMPTS = 8;
const LOOK_WAIT_MS = 150;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run one of these programs and hand back what it said, or null if it failed.
 *
 * Asynchronous on purpose. The daemon has one thread and every pty in every
 * window is on it, so a program run the blocking way stops the lot for as long
 * as it takes — and this one is talking to a window manager, which is exactly
 * the sort of thing that occasionally does not answer.
 */
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

/** The window whose title is exactly this, as wmctrl lists them. */
async function wmctrlFind(program, mark, env) {
  const out = await run(program, ['-l'], env);
  if (out === null) return null;
  for (const line of out.split('\n')) {
    // An id, the desktop it is on, the machine it is on, and then the title —
    // which is the rest of the line, spaces and all.
    const fields = /^(0x[0-9a-fA-F]+)\s+\S+\s+\S+ (.*)$/.exec(line.trimEnd());
    if (fields && fields[2] === mark) return fields[1];
  }
  return null;
}

/*
 * The numbers these take are the same ones the page reads off itself —
 * window.screenX and screenY, outerWidth and outerHeight — which is worth
 * saying because it is not obvious: a reparenting window manager puts the
 * client a title bar below the frame, and both of these speak in frames.
 * Measured against xfwm4 rather than assumed; see test/windows.mjs, which moves
 * a window from out here and checks the page agrees about where it landed.
 */
function wmctrlMove(program, id, { x, y, width, height }, env) {
  return run(program, ['-i', '-r', id, '-e', `0,${x},${y},${width},${height}`], env);
}

/**
 * How big the desktop is, across every monitor on it, or null if the program
 * would not say.
 *
 * Asked because a window manager, unlike a browser, will put a window wherever
 * it is told — including on a monitor that was unplugged since the position was
 * written down, where nobody would ever see it again. DG is the whole desktop
 * rather than WA, the part of it not under a panel: a window whose corner is
 * behind a panel is somewhere a person can still get at.
 */
async function wmctrlDesktop(program, env) {
  const out = await run(program, ['-d'], env);
  const size = /\bDG:\s*(\d+)x(\d+)/.exec(String(out || ''));
  return size ? { width: Number(size[1]), height: Number(size[2]) } : null;
}

/** Anything in a title that xdotool would otherwise read as a pattern. */
function literal(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function xdotoolFind(program, mark, env) {
  const out = await run(program, ['search', '--name', `^${literal(mark)}$`], env);
  const ids = String(out || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  // Two windows wearing one name is not something to guess at. It cannot
  // happen — the name has a container id in it — but moving the wrong window
  // is worse than moving none.
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

/**
 * Whatever this machine has for moving a window from outside, or null.
 *
 * Looked up each time rather than remembered, for the same reason the browser
 * list is: somebody who installs wmctrl this afternoon because clio said to
 * should not have to restart a daemon holding a day's shells to see it work.
 */
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

/** Is the corner this window would be put at somewhere on the desktop? */
function onDesktop({ x, y }, desktop) {
  return x >= 0 && y >= 0 && x < desktop.width && y < desktop.height;
}

/**
 * Move the window called `mark` to `geometry`, and say what happened.
 *
 * Every way this does not happen is a sentence rather than a code, because
 * there is only one thing to do about any of them — tell the page, which puts
 * its own title back and stays where the browser left it — and the sentence is
 * the only account of it anybody will ever see. The position stays on file
 * either way, which is what makes a monitor coming back the whole of the fix.
 */
export async function placeWindow(mark, geometry, env = process.env) {
  const placer = windowPlacer(env);
  if (!placer) {
    return {
      moved: false,
      install: true,
      why: 'a browser will not move a window between monitors, and nothing here can do it from outside',
    };
  }

  // A monitor that has been unplugged since this position was written down. The
  // browser's own refusal to leave the current screen quietly protected against
  // this; a window manager does as it is told, and would put the window
  // somewhere nobody could ever see or reach it.
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
