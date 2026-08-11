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

// A dedicated browser profile keeps the terminal out of the everyday browsing
// profile: no extensions injecting into it, no session-restore prompts, and
// clipboard permission granted once here rather than against normal browsing.
export const BROWSER_PROFILE_DIR = join(STATE_DIR, 'browser-profile');

export const HANDSHAKE_FILE = join(RUNTIME_DIR, 'daemon.json');
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
}
