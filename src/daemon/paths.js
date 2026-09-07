import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

const runtimeBase = process.env.XDG_RUNTIME_DIR || join(homedir(), '.cache');

const stateBase = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');

export const RUNTIME_DIR = join(runtimeBase, 'clio');
export const STATE_DIR = join(stateBase, 'clio');
export const SCROLLBACK_DIR = join(STATE_DIR, 'scrollback');

export const DROPS_DIR = join(STATE_DIR, 'drops');

export const BROWSER_PROFILE_DIR = join(STATE_DIR, 'browser-profile');

export const HANDSHAKE_FILE = join(RUNTIME_DIR, 'daemon.json');

export const HANDOVER_FILE = join(RUNTIME_DIR, 'handover.json');
export const STATE_FILE = join(STATE_DIR, 'state.json');

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
