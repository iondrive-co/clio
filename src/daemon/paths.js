import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

// Runtime dir holds the handshake file (pid/port/token). It is wiped on reboot,
// which is exactly what we want: a stale pointer to a dead daemon is worse than none.
const runtimeBase = process.env.XDG_RUNTIME_DIR || join(homedir(), '.cache');

// State dir survives reboots. This is what makes the snapshot fallback possible.
const stateBase = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');

export const RUNTIME_DIR = join(runtimeBase, 'clio');
export const STATE_DIR = join(stateBase, 'clio');
export const SCROLLBACK_DIR = join(STATE_DIR, 'scrollback');

// Files dragged into a window that are not on this disk anywhere else — an
// image out of a browser, a mail attachment. They are copied here so there is a
// path to type, and a path typed into a shell has to still be there tomorrow
// when somebody scrolls back to it, so this is state and not runtime. See
// src/daemon/drops.js, which prunes it.
export const DROPS_DIR = join(STATE_DIR, 'drops');

// A dedicated browser profile keeps the terminal out of the everyday browsing
// profile: no extensions injecting into it, no session-restore prompts, and
// clipboard permission granted once here rather than against normal browsing.
export const BROWSER_PROFILE_DIR = join(STATE_DIR, 'browser-profile');

export const HANDSHAKE_FILE = join(RUNTIME_DIR, 'daemon.json');

// Written by a daemon that is handing its shells to a replacement, and deleted
// by the replacement once it has them. Its presence is the successor's proof
// that the descriptors it inherited are meant for it.
export const HANDOVER_FILE = join(RUNTIME_DIR, 'handover.json');
export const STATE_FILE = join(STATE_DIR, 'state.json');

// Port and token are kept stable across daemon restarts so that a window left
// open when the daemon died can reconnect to its replacement on its own,
// instead of retrying an address that will never answer again.
export const IDENTITY_FILE = join(STATE_DIR, 'identity.json');

export function scrollbackFile(id) {
  return join(SCROLLBACK_DIR, `${id}.log`);
}

export function ensureDirs() {
  mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  mkdirSync(SCROLLBACK_DIR, { recursive: true, mode: 0o700 });
  mkdirSync(DROPS_DIR, { recursive: true, mode: 0o700 });
}
