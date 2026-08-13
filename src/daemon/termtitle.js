/*
 * What the program in a tab says it is doing.
 *
 * A terminal title is not a property of a terminal. It is a sentence the
 * program writes into the byte stream — `ESC ] 0 ; text BEL` — and whoever is
 * reading the stream is the only one who ever sees it. That used to be the
 * browser alone: xterm.js parses the sequence and hands the page a title, so a
 * tab could only be labelled with the job Claude Code is on once a terminal had
 * been built for it, which happens when somebody clicks the tab. Every tab
 * nobody had clicked was labelled `claude` — and after a restore that is every
 * tab but one.
 *
 * So the daemon reads them too. It is on the receiving end of every byte
 * anyway, it sees them for tabs no window has opened yet, and it is the side
 * that outlives the window.
 */

/**
 * OSC 0 (icon name and window title) or OSC 2 (window title), terminated by
 * BEL or by ST. A title cannot contain either an escape or a BEL, which is what
 * makes this safe to run over a stream full of other escape sequences.
 */
const OSC_TITLE = /\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

/**
 * The beginning of a title sequence whose end has not arrived yet. Output comes
 * in whatever sizes the kernel hands over, so a title is free to be split
 * across two reads — and one that is gets held rather than missed.
 */
const PARTIAL = /\x1b(?:\](?:[02](?:;[^\x07\x1b]*)?)?)?$/;

/**
 * How much of an unfinished sequence is worth keeping. Past this it is not a
 * title being typed slowly, it is a stream that happens to contain an escape,
 * and holding the rest of it would mean growing a buffer forever.
 */
const MAX_PARTIAL = 4096;

/** The last title in a piece of output, or null if it set none. */
export function lastTitleIn(text) {
  return new TitleReader().read(String(text ?? ''));
}

/**
 * Reads titles out of one session's output, one chunk at a time.
 *
 * Only the last title in a chunk is reported: a program that redraws its title
 * three times in a row is not saying three things, and the middle one was never
 * on screen anywhere else either.
 */
export class TitleReader {
  constructor() {
    this.carry = '';
  }

  /** Feed a chunk of output in; get the title it ended on, or null. */
  read(chunk) {
    const text = this.carry + chunk;

    let title = null;
    let end = 0;
    for (const match of text.matchAll(OSC_TITLE)) {
      title = match[1];
      end = match.index + match[0].length;
    }

    const unfinished = PARTIAL.exec(text.slice(end));
    this.carry = unfinished && unfinished[0].length <= MAX_PARTIAL ? unfinished[0] : '';

    return title;
  }
}
