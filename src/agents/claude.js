/*
 * Claude Code.
 *
 * What has to be worked out is which conversation a tab was showing, and the
 * only durable name for one is the session id. Claude does not advertise it:
 * it is not in the process's environment, which is fixed at exec and so cannot
 * hold an id generated afterwards, and the transcript is opened, appended to
 * and closed again rather than held, so it is not in the open descriptors
 * either. What it does do is write ~/.claude/projects/<slug>/<id>.jsonl, where
 * the file's name is the id — so the id is read off the filesystem, from the
 * newest transcript in this directory that was written while this process has
 * been running.
 *
 * That is a guess, and it is wrong in exactly one situation: two conversations
 * open in the same directory, one of them outside clio. The registry narrows it
 * by telling us which ids other tabs have already claimed, and an explicit
 * --resume on the command line beats the guess outright.
 */

import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** Filenames are the session id, and nothing else in the directory is. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/*
 * A transcript written before the process started belongs to an earlier
 * conversation in the same directory — yesterday's, most likely. The slack is
 * for the gap between exec and the first line being written, and for clocks
 * that disagree with themselves across a suspend.
 */
const CLOCK_SLACK_MS = 5000;

function base(path) {
  const parts = String(path || '').split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

/**
 * Where Claude keeps its transcripts.
 *
 * Read from the agent's own environment rather than the daemon's: clio is
 * started by a desktop launcher and knows nothing of a CLAUDE_CONFIG_DIR that
 * somebody exports in their shell profile, but the process that is actually
 * writing the transcripts does.
 */
function configDir(env) {
  return env?.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

/**
 * The directory of transcripts for one working directory.
 *
 * Claude names it after the path with every character that is not a letter or a
 * digit replaced by a dash, so /home/me/nop/.claude/worktrees becomes
 * -home-me-nop--claude-worktrees. The simpler encoding is tried as well, in case
 * that ever changes back, and a directory that does not exist is the honest
 * answer that there is nothing here to find.
 */
function projectDir(cwd, env) {
  if (!cwd) return null;
  const root = join(configDir(env), 'projects');
  const slugs = [cwd.replace(/[^a-zA-Z0-9]/g, '-'), cwd.replace(/\//g, '-')];
  for (const slug of slugs) {
    const dir = join(root, slug);
    if (existsSync(dir)) return dir;
  }
  return null;
}

/** Transcripts in this directory touched since `since`, newest first. */
function transcripts(dir, since) {
  const found = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue;
    const id = name.slice(0, -'.jsonl'.length);
    if (!SESSION_ID.test(id)) continue;
    try {
      const { mtimeMs } = statSync(join(dir, name));
      if (mtimeMs >= since) found.push({ id, mtimeMs });
    } catch {
      /* it was rotated away between the readdir and the stat */
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** The id Claude was told to resume, if it was told one. */
function resumeArgument(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--resume' || arg === '-r') {
      const next = argv[i + 1];
      if (next && SESSION_ID.test(next)) return next;
    }
    const inline = /^--resume=(.+)$/.exec(arg);
    if (inline && SESSION_ID.test(inline[1])) return inline[1];
  }
  return null;
}

export default {
  id: 'claude',
  name: 'Claude Code',

  /**
   * Claude, and not the several other things called claude on a desktop.
   *
   * A -p run is somebody's script piping a question through, not a conversation
   * anyone is sitting in front of: it would have exited on its own, and bringing
   * it back after a reboot would re-ask the question.
   */
  matches({ argv = [], exe = null }) {
    if (argv.some((arg) => arg === '-p' || arg === '--print')) return false;

    const first = base(argv[0]);
    if (first === 'claude' || base(exe) === 'claude') return true;

    // An npm install runs it through node: `node .../claude-code/cli.js`.
    if (first.startsWith('node') || base(exe).startsWith('node')) {
      return argv.slice(1).some((arg) => /claude[^/]*\/cli\.js$/.test(arg) || base(arg) === 'claude');
    }
    return false;
  },

  capture({ argv = [], cwd = null, startedAt = 0, env = null, previous = null, taken = new Set() }) {
    const dir = projectDir(cwd, env);
    const mine = previous?.sessionId || null;

    if (dir) {
      const since = Math.max(0, (startedAt || 0) - CLOCK_SLACK_MS);
      const seen = transcripts(dir, since);
      // Newest wins — starting a fresh conversation in a tab that had one is a
      // change of subject, not a second tab — except that another tab's
      // conversation is never stolen.
      const pick = seen.find((t) => t.id === mine || !taken.has(t.id));
      if (pick) return { v: 1, sessionId: pick.id, cwd, at: Math.round(pick.mtimeMs) };
    }

    // Nothing written yet. If it was started on a conversation, that is still
    // the conversation it is showing.
    const asked = resumeArgument(argv);
    if (asked) return { v: 1, sessionId: asked, cwd, at: null };

    return previous || { v: 1, sessionId: null, cwd, at: null };
  },

  resume(state, { cwd }) {
    if (state?.sessionId) {
      return {
        argv: ['claude', '--resume', state.sessionId],
        why: 'resuming the Claude Code conversation that was open here',
      };
    }
    // Claude was running, but had not written a word of it down — a session
    // opened and not yet used. Bring the agent back without pretending to know
    // what was in it.
    return {
      argv: ['claude'],
      why: 'starting Claude Code again — nothing had been said in the conversation that was open here',
      cwd,
    };
  },

  describe(state) {
    return state?.sessionId
      ? `a Claude Code conversation (${state.sessionId.slice(0, 8)})`
      : 'Claude Code';
  },
};
