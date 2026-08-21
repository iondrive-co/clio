/*
 * Claude Code.
 *
 * What has to be worked out is which conversation a tab was showing, and the
 * only durable name for one is the session id. Claude does not advertise it in
 * its own environment, which is fixed at exec and so cannot hold an id
 * generated afterwards, and the transcript is opened, appended to and closed
 * again rather than held, so it is not in the open descriptors either. What it
 * does do is write ~/.claude/projects/<slug>/<id>.jsonl, where the file's name
 * is the id — so the id can be read off the filesystem, from the newest
 * transcript in this directory that was written while this process has been
 * running.
 *
 * That last part is a guess, and it is wrong about the one thing that matters:
 * another conversation open in the same directory. Every tab in a repository
 * shares that directory, so the newest file in it belongs to whichever of them
 * wrote last — which on 21 August put four ~/ops conversations into the wrong
 * four tabs, each tab quietly recorded as holding its neighbour's, and a crash
 * then resumed exactly what had been written down. See `capture`.
 *
 * So a guess is now the last resort rather than the first answer, and two
 * things come before it, both of them about *this* process rather than about
 * the directory. Anything on its own command line — `--resume <id>` — is its
 * own by definition. And anything a child of it carries in
 * CLAUDE_CODE_SESSION_ID is too: the id does not exist at exec, but Claude Code
 * puts it into the environment of everything it starts afterwards, so its MCP
 * servers and tool shells hold the proof that its own environment cannot.
 * Neither of those can name a conversation belonging to the tab next door.
 *
 * What is left for the guess is a conversation that has written a file and
 * proved nothing — an agent with no MCP servers that has not run a tool yet.
 * Two things still narrow it there. The registry says which ids other tabs have
 * already claimed. And each transcript says which Claude Code wrote it, so the
 * desktop app's and a script's are not mistaken for a tab's — see TERMINAL.
 */

import { readdirSync, statSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** Filenames are the session id, and nothing else in the directory is. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/*
 * The entrypoint of a conversation that was held in a terminal.
 *
 * Claude Code in a terminal is not the only Claude Code writing into
 * ~/.claude/projects. The desktop app puts its conversations in the same tree,
 * and so does every `-p` run, every SDK script and every subagent — they share
 * the directory because the directory is named after the working directory,
 * which is the one thing they have in common. Each entry says which of them
 * wrote it, and `cli` is the terminal.
 *
 * That field is the whole of the fix for a real morning: on 15 August a tab in
 * ~/proteus came back as `claude --resume 646626df`, a conversation that had
 * been held in the desktop app and had never been in that tab or in any tab. It
 * was simply the newest file in the directory, and the newest file in the
 * directory was all this adapter looked at.
 */
const TERMINAL = 'cli';

/*
 * Where a running conversation says its own id out loud.
 *
 * Claude Code generates the id after exec, so it is not in its own environment
 * — but it exports it into every process it starts, and the ones it starts at
 * startup and keeps are its MCP servers. That is what turns "the newest file in
 * a shared directory" into "the file this process wrote": one readdir of
 * /proc/<pid>/task/<pid>/children and an environ each, next to a guess that has
 * put a conversation in the wrong tab twice.
 *
 * Nobody promises this variable — it is claude 2.1.238 — so nothing here
 * depends on finding it. A process with no children, or a claude that stops
 * exporting it, simply falls through to the older answers below, which is where
 * this adapter was before and is still correct about a tab on its own in a
 * directory.
 */
const SESSION_ENV = 'CLAUDE_CODE_SESSION_ID';

/*
 * How much of a transcript to read to find out who is writing it.
 *
 * The answer is in the first entry that carries one, and the few lines above it
 * are session settings — a couple of hundred bytes. Transcripts run to
 * megabytes, and this is asked on a poll, so reading one whole to learn a field
 * near the top of it is the sort of cost that gets noticed on a desktop with
 * thirty tabs open.
 */
const HEAD_BYTES = 64 * 1024;

/*
 * The glyphs Claude Code puts in front of the terminal title while it is
 * working.
 *
 * It writes one about twice a second — `◐ Search cost outstanding plan`, then
 * `◑ …`, and on — and when it stops, whether that is the end of a turn or a
 * question it is holding in front of you, it writes the same title with a still
 * glyph and then says nothing more. That is the only place a terminal can see
 * the difference: the process looks identical either way, and the transcript is
 * written a turn at a time and cannot tell "finished" from "stopped to ask".
 *
 * Which glyphs these are is nobody's promise — this is claude 2.1.237 — so the
 * other half of the answer is the title having stopped moving at all (see
 * WAITING_STILL_MS), and the two together decide what a strange glyph means. A
 * frame nobody here has heard of goes on rewriting the title every half second,
 * which is not stillness either, so it is answered with "no opinion": if the
 * spinner is ever redrawn the tab quietly stops flashing until a frame is added
 * to this line, rather than flashing at somebody about work in progress. Of the
 * two ways for this to be wrong, that is the one worth having.
 */
const SPINNER = new Set(['◐', '◑', '◒', '◓']);

/*
 * How long a title has to sit unchanged before it is somebody waiting rather
 * than a spinner between frames. Frames arrive about every 500ms; three of
 * those is long enough to be sure of, and short enough that a tab lights up
 * while whoever left it is still in the room.
 */
const WAITING_STILL_MS = 1500;

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

/**
 * Which Claude Code wrote this transcript, or null if it has not said yet.
 *
 * The field is on the first entry that carries one; the handful of lines above
 * it set the session's mode and have none. Parsed a line at a time rather than
 * searched for as text, because everything in a transcript that a person or a
 * tool typed is in there as text too, and one of them saying `"entrypoint"` is
 * not the transcript saying it.
 */
function writtenBy(file) {
  let fd = null;
  try {
    fd = openSync(file, 'r');
    const buffer = Buffer.allocUnsafe(HEAD_BYTES);
    const read = readSync(fd, buffer, 0, HEAD_BYTES, 0);
    const lines = buffer.toString('utf8', 0, read).split('\n');
    // The last line is cut in half whenever the file is longer than the read.
    if (read === HEAD_BYTES) lines.pop();
    for (const line of lines) {
      if (!line.includes('"entrypoint"')) continue;
      try {
        const entry = JSON.parse(line);
        if (typeof entry?.entrypoint === 'string') return entry.entrypoint;
      } catch {
        /* not an entry, or not a whole one: the next line will do */
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * Could this conversation have been the one in a tab?
 *
 * A transcript that names an entrypoint which is not the terminal belongs to
 * something a terminal cannot bring back, and saying nothing is not the same
 * answer: a conversation opened a moment ago has not written a turn yet, and
 * refusing it would lose the tab that has just started one. So the question is
 * asked the cautious way round — the only ones ruled out are the ones that have
 * said, in as many words, that they are somebody else's.
 */
function inATerminal(dir, id) {
  const by = writtenBy(join(dir, `${id}.jsonl`));
  return by === null || by === TERMINAL;
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

/**
 * The conversations this process can be shown to own, the command line first.
 *
 * "Shown" is the point of it. Everything else this adapter knows comes from a
 * directory that every tab in the same repository writes into, where the only
 * question that can be answered is which file was touched last — and the answer
 * to that is somebody else's conversation as often as it is this one's. These
 * two say *this process*: the id it was started on, and the ids its own
 * children are carrying. A tab cannot pick up either of them by accident.
 *
 * Both are collected rather than one preferred, because a process can own more
 * than one in a lifetime: a tab is resumed onto a conversation and may then be
 * moved off it — `/clear` starts a new one without the process changing — and
 * the children spawned since are the only ones who know about that. Which of
 * them it is *on* is then the ordinary question of which was written last, asked
 * of these instead of the whole directory. The command line goes in first only
 * so that it is the one answered with when none of them has written a file yet.
 */
function ownedBy(argv, children) {
  const owned = new Set();
  const asked = resumeArgument(argv);
  if (asked) owned.add(asked);
  for (const env of children) {
    const id = env?.[SESSION_ENV];
    if (id && SESSION_ID.test(id)) owned.add(id);
  }
  return owned;
}

/**
 * Claude, and not the several other things called claude on a desktop.
 *
 * A -p run is somebody's script piping a question through, not a conversation
 * anyone is sitting in front of: it would have exited on its own, and bringing
 * it back after a reboot would re-ask the question.
 *
 * One function rather than two because it is asked twice about the same tab —
 * once of a live process, once of the command line left behind by a dead one —
 * and the two answers disagreeing is a bug that only shows up on the worst
 * morning. It did, in a version of this file that lasted an hour: an
 * npm-installed claude appears as `node …/claude`, which the live check knew
 * about and the other did not.
 */
function isClaude(argv = [], exe = null) {
  if (argv.some((arg) => arg === '-p' || arg === '--print')) return false;

  const first = base(argv[0]);
  if (first === 'claude' || base(exe) === 'claude') return true;

  // An npm install runs it through node: `node .../claude-code/cli.js`.
  if (first.startsWith('node') || base(exe).startsWith('node')) {
    return argv.slice(1).some((arg) => /claude[^/]*\/cli\.js$/.test(arg) || base(arg) === 'claude');
  }
  return false;
}

export default {
  id: 'claude',
  name: 'Claude Code',

  matches({ argv = [], exe = null }) {
    return isClaude(argv, exe);
  },

  /**
   * The conversation this tab has claimed.
   *
   * A conversation belongs to one tab. Two claudes open in the same directory
   * would otherwise both be recorded as whichever transcript was written last,
   * and a restore would put the same conversation into both tabs.
   */
  identify(state) {
    return state?.sessionId || null;
  },

  /**
   * Working, or waiting for the person whose tab this is?
   *
   * Answered from the title and nothing else, because the title is the only
   * thing Claude Code says out loud that says which — and it is already on its
   * way past the daemon for every tab, whether or not a window has been opened
   * on it. The alternatives are worse than they look: a hook would have to be
   * installed in somebody's settings before any of this worked at all, and the
   * transcript's last entry looks the same at the end of a turn as it does with
   * a permission prompt on screen.
   *
   * `null` is a real answer and the honest one for the first second after
   * anything changes: the title has not settled, and nobody should be told
   * anything yet.
   */
  activity(state, { termTitle = null, titleAt = 0, now = Date.now() } = {}) {
    if (!termTitle) return null;
    // The first codepoint rather than the first character: these glyphs sit in
    // the BMP today, but one that did not would arrive as half a surrogate pair
    // and match nothing at all.
    if (SPINNER.has([...termTitle][0])) return 'working';
    return now - titleAt >= WAITING_STILL_MS ? 'waiting' : null;
  },

  /**
   * Which conversation is in this tab, in descending order of how sure of it
   * this can be.
   *
   * Proof, then a claim that is still true, then a guess. The order is the
   * whole of the fix for 21 August: it used to be the guess first — newest file
   * in the directory wins, on the reasoning that starting a fresh conversation
   * in a tab that had one is a change of subject rather than a second tab. It is
   * that, when the tab is on its own in the directory. When it is not, "newest
   * file" is the tab next door finishing a turn, and this recorded a tab as
   * holding its neighbour's conversation while the neighbour was still in it.
   * Nothing looked wrong until the crash, because a tab goes on showing the
   * conversation it is showing whatever clio has written down about it — and
   * then the restore typed what had been written down into four ~/ops tabs and
   * shuffled the morning's work between them.
   */
  capture({
    argv = [],
    cwd = null,
    startedAt = 0,
    env = null,
    children = [],
    previous = null,
    taken = new Set(),
  }) {
    const dir = projectDir(cwd, env);
    const mine = previous?.sessionId || null;
    const owned = ownedBy(argv, children);

    if (dir) {
      const since = Math.max(0, (startedAt || 0) - CLOCK_SLACK_MS);
      const seen = transcripts(dir, since);

      // Proof, and it outranks everything below including another tab's claim:
      // an id this process was started on, or that its own children carry, is
      // not something the tab next door can have. If somebody else has it
      // written down, their record is the one that is wrong, and they are asked
      // to pick again on the next pass — see the count in
      // SessionManager.pollExtensions.
      const proven = seen.find((t) => owned.has(t.id));
      if (proven) return { v: 1, sessionId: proven.id, cwd, at: Math.round(proven.mtimeMs) };

      // No proof, but this tab's own claim is still being written, so it is
      // still true and is not revised — not for a newer file, which is the tab
      // next door, and not for anything else in a directory this one shares.
      // Taken at its word without a file being opened: it is the answer on
      // almost every poll.
      //
      // Unless somebody else has the same claim, which is the one case where
      // giving it up is right: two tabs on one conversation is one of them
      // typing over the other, and a tab that will not let go of a contested
      // claim is how the pair of them never come apart again.
      const held = mine && !taken.has(mine) ? seen.find((t) => t.id === mine) : null;
      if (held) return { v: 1, sessionId: held.id, cwd, at: Math.round(held.mtimeMs) };

      // Nothing proved and nothing held: the newest conversation in the
      // directory that no other tab has claimed and that was written in a
      // terminal. A guess, and the only thing here that can be wrong about
      // which tab a conversation was in.
      const guess = seen.find((t) => !taken.has(t.id) && inATerminal(dir, t.id));
      if (guess) return { v: 1, sessionId: guess.id, cwd, at: Math.round(guess.mtimeMs) };
    }

    // Nothing written yet — a conversation opened a moment ago, or a resume
    // whose transcript is in a directory this cannot see. What the process
    // names is still the conversation it is showing.
    const [named] = owned;
    if (named) return { v: 1, sessionId: named, cwd, at: null };

    return previous || { v: 1, sessionId: null, cwd, at: null };
  },

  /**
   * Which conversation was in a tab that has no record of one.
   *
   * Reached when a shell has to be rebuilt and nothing was written down — the
   * daemon that was holding it predated this adapter, or was told not to
   * remember. All that survives is the command line the tab was running and the
   * directory it was in, and the id is not in the command line: `--resume` on
   * its own is how somebody picks a conversation from claude's own list.
   *
   * So it comes off the filesystem, newest first, with no process to bound it
   * by — which is the part that makes this a guess rather than an answer. Two
   * conversations in one directory and this names the one touched last. Good
   * enough to put in front of somebody; not good enough to run at them.
   */
  recover({ command = '', cwd = null }) {
    const words = String(command).trim().split(/\s+/);
    if (!isClaude(words)) return null;

    const asked = resumeArgument(words);
    if (asked) return { v: 1, sessionId: asked, cwd, at: null };

    const dir = projectDir(cwd, null);
    const newest = dir ? transcripts(dir, 0).find((t) => inATerminal(dir, t.id)) : null;
    return newest ? { v: 1, sessionId: newest.id, cwd, at: Math.round(newest.mtimeMs) } : null;
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
