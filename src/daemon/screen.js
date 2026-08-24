/*
 * What is on the screen, as far as anyone can tell from the bytes.
 *
 * ./output.js asks whether output could have changed the screen, by taking out
 * everything that cannot and seeing whether anything is left. That is the right
 * question for a tab going red, and it has one answer it cannot give: bytes
 * that change the screen and then change it back.
 *
 * Claude Code checks for a new version every thirty minutes — 1800000ms, on a
 * timer of its own — and while the check is in flight it writes the answer into
 * its footer and then wipes it again. Two frames, 249 bytes, on 21 August:
 *
 *   \e[?25l\e[H\r\e[189C\e[39B  current: 2.1.238 · latest: 2.1.238  \e[225G Checking for update
 *   \e[?25l\e[H\r\e[189C\e[39B  <34 spaces>                         \e[225G <7 spaces> 283539 token
 *
 * The second frame puts the footer back the way it was. Nothing happened in
 * that tab, nobody was asked anything, and there is nothing in it to read — but
 * each frame on its own is text, so each one is output that could have changed
 * the screen, and every idle agent on the desktop went red for it twice an
 * hour. With sixteen of them open that is a tab lighting up every couple of
 * minutes, all of them saying nothing.
 *
 * So the question is asked of the screen instead of the bytes: this keeps a
 * grid of characters, the same bytes are fed to it, and what a tab is compared
 * against is what was on it the last time somebody looked. A repaint of the
 * same screen is not news, whatever it cost in bytes.
 *
 * Three things this deliberately does not model, because none of them is
 * something to read:
 *
 *   - Colour. A cell is a character and nothing else, which is the same
 *     bargain ./output.js already made about SGR.
 *   - The cursor. A program that moves the cursor about and draws nothing has
 *     drawn nothing.
 *   - Character widths. A double-width glyph advances one cell here and two on
 *     a real terminal, so a line with emoji in it sits at the wrong columns —
 *     but it sits at the *same* wrong columns every time, and every comparison
 *     is between two of these grids, never between one of these and a terminal.
 *
 * And the one thing it is careful about: `sure`. Anything not understood — an
 * escape sequence nobody here has heard of, a sixel image, insert mode — sets
 * it false, and a screen that is not sure of itself is not allowed to say
 * "nothing happened". The caller falls back to ./output.js, which is where clio
 * was before this file existed. Of the two ways to be wrong, a tab that goes
 * red for a repaint is the one worth having.
 */

/** A cell nothing has written to. Reads as a space; see hashRow. */
const UNWRITTEN = 0;
const SPACE = 0x20;

/**
 * How much of an unfinished escape sequence is worth holding on to. Output
 * arrives in whatever sizes the kernel hands over, so a sequence is free to be
 * split across two reads; past this it is not a sequence arriving slowly, it is
 * a stream that happens to contain an escape.
 */
const MAX_PARTIAL = 4096;

/** Tabs land every eight columns. Nothing here honours a program's own stops. */
const TAB = 8;

/** The screen is bounded on purpose: a runaway parameter is not a scrollback. */
const MAX_COLS = 1000;
const MAX_ROWS = 500;

/**
 * How many lines a program may rewrite where lines already were before it is
 * telling you something rather than talking about itself. See isNews.
 *
 * A status block is a line or two: a spinner, a clock, a token count, a version
 * banner. Claude Code's is two — the line it spins on, and the counter along the
 * right of the row under it. What this must not swallow is bigger by a factor of
 * ten, so there is a lot of room between the two: a question that agent puts on
 * the screen redraws the frame it sits in, thirty rows and up.
 */
const STATUS_ROWS = 2;

/**
 * The alternate screen, in each of the ways a program asks for it. 1049 is what
 * everything written this century sends; the other two are what it grew out of.
 */
const SCREEN_MODES = new Set([47, 1047, 1049]);
const PRIVATE_MODE = /\x1b\[\?([0-9;]*)([hl])/g;

/** The next thing that is not a printable character. */
const PLAIN = /[\x00-\x1f\x7f]/g;

const CSI = /\x1b\[([\x30-\x3f]*)([\x20-\x2f]*)([\x40-\x7e])/y;
const CSI_PARTIAL = /\x1b\[[\x30-\x3f]*[\x20-\x2f]*$/y;
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/y;
const OSC_PARTIAL = /\x1b\][^\x07\x1b]*\x1b?$/y;
/** DCS, APC, PM and SOS: what a terminal says about itself, and Kitty's images. */
const STRING = /\x1b([P_^X])([^\x1b]*)\x1b\\/y;
const STRING_PARTIAL = /\x1b[P_^X][^\x1b]*\x1b?$/y;

/** Fowler–Noll–Vo, because a digest here only has to be cheap and stable. */
const HASH_SEED = 0x811c9dc5;
const HASH_PRIME = 0x01000193;

function mix(hash, value) {
  return Math.imul(hash ^ value, HASH_PRIME) >>> 0;
}

/**
 * One row of characters, hashed.
 *
 * A cell nothing ever wrote to and a cell somebody wrote a space into look
 * identical on a screen, so they have to hash identically here — that is not a
 * detail, it is the whole of the update-check case. The footer's blanks were
 * never written; the frame that wipes the footer writes spaces over them. If
 * those two were different values, the screen would come back "changed" and the
 * tab would go red for the wipe instead of for the write.
 */
function hashRow(cells, cols) {
  let hash = HASH_SEED;
  for (let x = 0; x < cols; x++) {
    const cell = cells[x];
    hash = mix(hash, cell === UNWRITTEN ? SPACE : cell);
  }
  return hash;
}

/**
 * What an empty row of this width hashes to.
 *
 * Which is the same as a row of spaces, by the paragraph above, and is how a
 * snapshot tells a line that is there from a line that is not — see isNews.
 * Memoised because there are only ever a handful of widths on a desktop.
 */
const BLANK_ROWS = new Map();

function blankHash(cols) {
  let hash = BLANK_ROWS.get(cols);
  if (hash === undefined) {
    hash = hashRow(new Array(cols).fill(UNWRITTEN), cols);
    BLANK_ROWS.set(cols, hash);
  }
  return hash;
}

/**
 * A screen's worth of rows, and whether they are ours to trust.
 *
 * `known` is per grid rather than per screen because a program that switches to
 * the alternate screen gets a blank one — which is a screen this can be sure of
 * even when it had lost track of the one underneath. (Named for what it is
 * rather than the terminal's own word for it, `buffer`, which in this file
 * would shadow Node's.)
 */
class Grid {
  constructor(cols, rows, known) {
    this.cols = cols;
    this.rows = rows;
    this.known = known;
    this.lines = [];
    this.hashes = [];
    for (let y = 0; y < rows; y++) this.lines.push(this.blank());
  }

  blank() {
    return new Array(this.cols).fill(UNWRITTEN);
  }

  /** The row, grown if a resize left it short. */
  row(y) {
    const line = this.lines[y];
    if (line.length < this.cols) {
      for (let x = line.length; x < this.cols; x++) line.push(UNWRITTEN);
    }
    return line;
  }

  changed(y) {
    this.hashes[y] = null;
  }

  digest() {
    let hash = mix(mix(HASH_SEED, this.cols), this.rows);
    for (let y = 0; y < this.rows; y++) {
      if (this.hashes[y] == null) this.hashes[y] = hashRow(this.row(y), this.cols);
      hash = mix(hash, this.hashes[y]);
    }
    return hash;
  }
}

export class Screen {
  /**
   * `known` is false for a screen that already had something on it — the ptys a
   * daemon inherits from the one it replaced, whose scrollback happened
   * somewhere else. Nothing about those cells can be worked out from the bytes
   * that arrive afterwards, so such a screen never says "nothing happened"
   * until a program clears it.
   */
  constructor({ cols = 80, rows = 24, known = true } = {}) {
    this.cols = clamp(cols, 1, MAX_COLS);
    this.rows = clamp(rows, 1, MAX_ROWS);
    this.main = new Grid(this.cols, this.rows, known);
    this.alt = null;
    this.grid = this.main;

    this.x = 0;
    this.y = 0;
    this.top = 0;
    this.bottom = this.rows - 1;
    this.autowrap = true;
    /** The deferred wrap a terminal does: the column is full, the cursor is not. */
    this.pendingWrap = false;
    this.savedCursor = null;
    /**
     * Do we know where the cursor is?
     *
     * Set by anything that places it absolutely, unset by anything not
     * understood — which may have moved it. Everything that touches cells
     * relative to the cursor asks, because text written from a position this
     * has lost track of lands in the wrong row, and a grid with text in the
     * wrong row is not a grid anybody should compare against.
     */
    this.placed = known;
    this.carry = '';
  }

  /** Has everything that reached this screen been understood? */
  get sure() {
    return this.grid.known;
  }

  /** This screen is not ours to know: something was on it before we arrived. */
  forget() {
    this.grid.known = false;
    this.placed = false;
  }

  /** A number that changes when the characters on the screen change. */
  digest() {
    return `${this.grid === this.alt ? 'alt' : 'main'}:${this.grid.digest()}`;
  }

  /**
   * The screen as one hash per row, to be compared against a later one.
   *
   * `digest` says whether the screen changed. This says *which lines*, which is
   * the difference between a program drawing something and a program saying how
   * many tokens it has spent — see isNews. It costs a digest and no more: the
   * row hashes are the ones the digest is already made of.
   */
  snapshot() {
    const rows = new Array(this.rows);
    for (let y = 0; y < this.rows; y++) {
      if (this.grid.hashes[y] == null) this.grid.hashes[y] = hashRow(this.grid.row(y), this.cols);
      rows[y] = this.grid.hashes[y];
    }
    return {
      grid: this.grid === this.alt ? 'alt' : 'main',
      cols: this.cols,
      rows,
      blank: blankHash(this.cols),
    };
  }

  /**
   * What is on the screen, a row of text per line, trailing blanks trimmed.
   *
   * Nothing in the daemon needs this — the flag is decided on digests. It is
   * what makes the model checkable: test/unseen.mjs puts the same bytes through
   * xterm.js, which is the terminal these tabs are really drawn in, and
   * compares the two screens row by row. A hand-written model of somebody
   * else's terminal is worth exactly what it can be held against.
   */
  text() {
    const rows = [];
    for (let y = 0; y < this.rows; y++) {
      const line = this.grid.row(y);
      let row = '';
      for (let x = 0; x < this.cols; x++) row += String.fromCodePoint(line[x] || SPACE);
      rows.push(row.replace(/\s+$/, ''));
    }
    return rows;
  }

  /**
   * The pane is a different size.
   *
   * A real terminal reflows the lines it is holding; this keeps them and moves
   * the edges, which is the one place this model knowingly says something
   * untrue about the screen. It is also the one place clio does something about
   * it: a resize is followed by Session.nudgeRedraw asking whatever is in the
   * tab to paint itself again, and a full-screen program answering that puts
   * every cell back under this file's nose. What it costs in the meantime is a
   * tab that goes red for a resize nobody watched, which is the safe direction.
   */
  resize(cols, rows) {
    const wide = clamp(cols, 1, MAX_COLS);
    const tall = clamp(rows, 1, MAX_ROWS);
    if (wide === this.cols && tall === this.rows) return;
    this.cols = wide;
    this.rows = tall;
    for (const grid of [this.main, this.alt]) {
      if (!grid) continue;
      grid.cols = wide;
      grid.hashes = [];
      while (grid.lines.length < tall) grid.lines.push(grid.blank());
      grid.rows = tall;
    }
    this.top = 0;
    this.bottom = tall - 1;
    this.x = Math.min(this.x, wide - 1);
    this.y = Math.min(this.y, tall - 1);
    this.pendingWrap = false;
  }

  /**
   * Feed output in.
   *
   * Never throws: this is on the path every byte of every tab takes, and a
   * screen model that can end a session's output is worse than no screen model
   * at all. Anything that goes wrong in here comes out as a screen that is not
   * sure of itself, which is the answer clio had before this file existed.
   */
  write(text) {
    try {
      this.parse(this.carry + String(text ?? ''));
    } catch {
      this.carry = '';
      this.forget();
    }
  }

  parse(text) {
    this.carry = '';
    let i = 0;
    while (i < text.length) {
      const code = text.codePointAt(i);
      if (code === 0x1b) {
        const took = this.escape(text, i);
        if (took === 0) {
          // The end of it has not arrived. Hold it for the next chunk — a title
          // or a cursor move split across two reads is not a stream this has
          // lost, unless it is long enough that it never was one.
          const tail = text.slice(i);
          if (tail.length <= MAX_PARTIAL) this.carry = tail;
          else this.forget();
          return;
        }
        i += took;
        continue;
      }
      if (code < 0x20 || code === 0x7f) {
        this.control(code);
        i += 1;
        continue;
      }
      // Everything up to the next control character or escape is text, and text
      // is most of what comes out of a terminal — a build's output is nothing
      // else. Written a run at a time rather than a character at a time, which
      // is worth the extra loop: this runs on every byte of every tab.
      PLAIN.lastIndex = i;
      const stop = PLAIN.exec(text) ? PLAIN.lastIndex - 1 : text.length;
      i = this.printRun(text, i, stop);
    }
  }

  // ---- the characters themselves ----------------------------------------

  /**
   * Put `text` from `from` up to `stop` on the screen, and say where it got to.
   *
   * A row at a time: everything that fits on this line goes down in one pass,
   * and the wrap — which a terminal defers until the character *after* the one
   * that filled the last column — starts the next.
   */
  printRun(text, from, stop) {
    let i = from;
    while (i < stop) {
      if (this.pendingWrap && this.autowrap) {
        this.x = 0;
        this.lineFeed();
      }
      this.pendingWrap = false;
      this.touch();
      const row = this.grid.row(this.y);
      let x = this.x;
      while (i < stop && x < this.cols) {
        const code = text.codePointAt(i);
        row[x] = code;
        x += 1;
        i += code > 0xffff ? 2 : 1;
      }
      this.grid.changed(this.y);
      if (x < this.cols) {
        this.x = x;
        continue;
      }
      // The last column is full. A terminal with wrapping on waits here for the
      // next character before moving; one with it off overwrites this cell for
      // the rest of the line, so the last character written is what stays.
      this.x = this.cols - 1;
      if (this.autowrap) {
        this.pendingWrap = true;
      } else {
        row[this.cols - 1] = text.codePointAt(stop - 1);
        return stop;
      }
    }
    return i;
  }

  control(code) {
    switch (code) {
      case 0x08: // backspace
        this.pendingWrap = false;
        this.x = Math.max(0, this.x - 1);
        break;
      case 0x09: // tab
        this.pendingWrap = false;
        this.x = Math.min(this.cols - 1, (Math.floor(this.x / TAB) + 1) * TAB);
        break;
      case 0x0a:
      case 0x0b:
      case 0x0c:
        this.pendingWrap = false;
        this.lineFeed();
        break;
      case 0x0d:
        this.pendingWrap = false;
        this.x = 0;
        break;
      default:
        // Bell, shift in, shift out, and the rest of the C0 controls: audible,
        // or about character sets, and none of them puts anything on a screen.
        break;
    }
  }

  // ---- escape sequences -------------------------------------------------

  /** How many characters were consumed, or 0 for one that has not finished. */
  escape(text, at) {
    const next = text[at + 1];
    if (next === undefined) return 0;
    if (next === '[') return this.csi(text, at);
    if (next === ']') return this.osc(text, at);
    if (next === 'P' || next === '_' || next === '^' || next === 'X') {
      return this.string(text, at);
    }
    // An escape with one more character after it. Character sets, and the
    // alignment pattern nothing has drawn since 1983.
    if ('()*+#% '.includes(next)) {
      if (text[at + 2] === undefined) return 0;
      if (next === '#' && text[at + 2] === '8') this.fill(0x45);
      return 3;
    }
    switch (next) {
      case '7':
        this.save();
        return 2;
      case '8':
        this.restore();
        return 2;
      case 'D': // index
        this.lineFeed();
        return 2;
      case 'E': // next line
        this.x = 0;
        this.lineFeed();
        return 2;
      case 'M': // reverse index
        this.reverseIndex();
        return 2;
      case 'H': // a tab stop, and this file tabs in eights regardless
      case '=':
      case '>': // keypad modes
      case '\\': // a string terminator with nothing in front of it
      case 'Z': // "what are you", answered by the terminal
        return 2;
      case 'c':
        this.reset();
        return 2;
      default:
        this.forget();
        return 2;
    }
  }

  osc(text, at) {
    OSC.lastIndex = at;
    if (OSC.exec(text)) return OSC.lastIndex - at;
    OSC_PARTIAL.lastIndex = at;
    if (OSC_PARTIAL.exec(text)) return 0;
    this.forget();
    return 2;
  }

  string(text, at) {
    STRING.lastIndex = at;
    const found = STRING.exec(text);
    if (found) {
      // Sixel is the one of these that draws. Everything else — the terminal's
      // answers about itself, Kitty's key protocol — is talk, not paint.
      if (found[1] === 'P' && /q/.test(found[2].slice(0, 8))) this.forget();
      return STRING.lastIndex - at;
    }
    STRING_PARTIAL.lastIndex = at;
    if (STRING_PARTIAL.exec(text)) return 0;
    this.forget();
    return 2;
  }

  csi(text, at) {
    CSI.lastIndex = at;
    const found = CSI.exec(text);
    if (!found) {
      CSI_PARTIAL.lastIndex = at;
      if (CSI_PARTIAL.exec(text)) return 0;
      this.forget();
      return 2;
    }
    const took = CSI.lastIndex - at;
    const raw = found[1];
    const priv = raw && '<=>?'.includes(raw[0]) ? raw[0] : '';
    const args = (priv ? raw.slice(1) : raw).split(';');
    const final = found[3];

    /** A count: absent or zero means one of whatever it is. */
    const count = (i) => {
      const value = parseInt(args[i], 10);
      return Number.isFinite(value) && value > 0 ? Math.min(value, MAX_ROWS * MAX_COLS) : 1;
    };
    /** A choice between behaviours, where absent means the first of them. */
    const choice = (i) => {
      const value = parseInt(args[i], 10);
      return Number.isFinite(value) && value > 0 ? value : 0;
    };

    const inter = found[2];
    if (inter) {
      // An intermediate byte makes it a different sequence with the same final
      // one: `\e[$r` changes the colours in a rectangle, `\e[!p` resets half the
      // modes this file tracks. The handful that are safe to walk past are
      // reports, mode queries and the shape of the cursor; the rest are things
      // this would otherwise mistake for something it knows.
      if (!'mnqtx'.includes(final) && !(final === 'p' && inter !== '!')) this.forget();
      return took;
    }

    // Selective erase — the same erase, sparing cells a program marked as
    // protected, which nothing has done since the VT200.
    const erase = priv === '?' && (final === 'J' || final === 'K');

    if (priv && !erase && final !== 'h' && final !== 'l') {
      // Device attributes, XTVERSION, XTMODKEYS, the Kitty keyboard stack, mode
      // queries. All of them are a program asking the terminal something, or
      // telling it how to send keys, and none of them draws.
      return took;
    }

    switch (final) {
      case 'A':
        this.moveTo(this.x, this.y - count(0));
        break;
      case 'B':
        this.moveTo(this.x, this.y + count(0));
        break;
      case 'C':
        this.moveTo(this.x + count(0), this.y);
        break;
      case 'D':
        this.moveTo(this.x - count(0), this.y);
        break;
      case 'E':
        this.moveTo(0, this.y + count(0));
        break;
      case 'F':
        this.moveTo(0, this.y - count(0));
        break;
      case 'G':
      case '`':
        this.column(count(0) - 1);
        break;
      case 'd':
        this.line(count(0) - 1);
        break;
      case 'H':
      case 'f':
        this.place(count(1) - 1, count(0) - 1);
        break;
      case 'I':
        this.tabs(count(0));
        break;
      case 'Z':
        this.tabs(-count(0));
        break;
      case 'J':
        this.eraseScreen(choice(0));
        break;
      case 'K':
        this.eraseLine(choice(0));
        break;
      case 'L':
        this.insertLines(count(0));
        break;
      case 'M':
        this.deleteLines(count(0));
        break;
      case '@':
        this.insertCells(count(0));
        break;
      case 'P':
        this.deleteCells(count(0));
        break;
      case 'X':
        this.eraseCells(count(0));
        break;
      case 'S':
        this.scrollUp(count(0));
        break;
      case 'T':
        this.scrollDown(count(0));
        break;
      case 'r':
        this.region(choice(0), choice(1));
        break;
      case 's':
        this.save();
        break;
      case 'u':
        this.restore();
        break;
      case 'h':
      case 'l':
        this.mode(priv, args, final === 'h');
        break;
      case 'm': // colour, which nothing can be read off
      case 'n': // "how are you"
      case 'c': // "what are you"
      case 'q': // the shape of the cursor
      case 'g': // tab stops
      case 'i': // send this to the printer
      case 'p': // soft reset, and mode queries
      case 't': // move my window about
      case 'x': // report your settings
        break;
      default:
        this.forget();
        break;
    }
    return took;
  }

  /**
   * Modes.
   *
   * Almost all of them are invisible — the cursor's own visibility, mouse
   * reporting, bracketed paste, focus reporting — and the ones that are not are
   * the three below. Insert mode and origin mode are called out rather than
   * ignored because both change where the characters that follow end up, which
   * is exactly the kind of wrongness this file must not be quietly confident
   * about. Nothing on this desktop has ever sent either.
   */
  mode(priv, args, set) {
    for (const arg of args) {
      const which = parseInt(arg, 10);
      if (!Number.isFinite(which)) continue;
      if (priv === '?') {
        if (which === 7) this.autowrap = set;
        else if (which === 47 || which === 1047 || which === 1049) this.alternate(set);
        else if (which === 6) this.forget(); // origin mode moves where CUP lands
      } else if (which === 4) {
        this.forget(); // insert mode pushes a line sideways as it is typed
      }
    }
  }

  /**
   * The alternate screen: less, vim, fzf, and anything else that borrows the
   * whole terminal and gives it back.
   *
   * A blank buffer of its own, which is a screen this can be sure of even when
   * it had lost track of the one underneath — and the one underneath is
   * untouched, so what a person sees when the program exits is what they saw
   * before it started. Which is also the honest answer to whether anything
   * happened while they were away.
   */
  alternate(on) {
    if (on) {
      if (this.grid === this.alt) return;
      this.save();
      this.alt = new Grid(this.cols, this.rows, true);
      this.grid = this.alt;
      this.top = 0;
      this.bottom = this.rows - 1;
      this.place(0, 0);
      return;
    }
    if (this.grid !== this.alt) return;
    this.grid = this.main;
    this.alt = null;
    this.top = 0;
    this.bottom = this.rows - 1;
    this.restore();
  }

  reset() {
    this.main = new Grid(this.cols, this.rows, true);
    this.alt = null;
    this.grid = this.main;
    this.top = 0;
    this.bottom = this.rows - 1;
    this.autowrap = true;
    this.savedCursor = null;
    this.place(0, 0);
  }

  // ---- the cursor -------------------------------------------------------

  /**
   * Anything about to touch a cell says so first.
   *
   * If the cursor's position was lost, whatever is written now lands in the
   * wrong place, and the grid stops being something worth comparing. Saying it
   * here rather than in a dozen callers is why there is one of these.
   */
  touch() {
    if (!this.placed) this.grid.known = false;
  }

  moveTo(x, y) {
    this.pendingWrap = false;
    this.x = clamp(x, 0, this.cols - 1);
    this.y = clamp(y, 0, this.rows - 1);
  }

  /** An absolute position, which is also how the cursor becomes known again. */
  place(x, y) {
    this.moveTo(x, y);
    this.placed = true;
  }

  column(x) {
    this.place(x, this.y);
  }

  line(y) {
    this.place(this.x, y);
  }

  tabs(n) {
    this.pendingWrap = false;
    let x = this.x;
    for (let i = 0; i < Math.abs(n); i++) {
      x = n > 0 ? (Math.floor(x / TAB) + 1) * TAB : (Math.ceil(x / TAB) - 1) * TAB;
    }
    this.x = clamp(x, 0, this.cols - 1);
  }

  save() {
    this.savedCursor = { x: this.x, y: this.y, placed: this.placed };
  }

  restore() {
    if (!this.savedCursor) {
      this.place(0, 0);
      return;
    }
    this.x = clamp(this.savedCursor.x, 0, this.cols - 1);
    this.y = clamp(this.savedCursor.y, 0, this.rows - 1);
    this.placed = this.savedCursor.placed;
    this.pendingWrap = false;
  }

  region(top, bottom) {
    const first = clamp((top || 1) - 1, 0, this.rows - 1);
    const last = clamp((bottom || this.rows) - 1, 0, this.rows - 1);
    if (last <= first) {
      this.top = 0;
      this.bottom = this.rows - 1;
    } else {
      this.top = first;
      this.bottom = last;
    }
    this.place(0, this.top);
  }

  lineFeed() {
    if (this.y === this.bottom) {
      this.scrollUp(1);
      return;
    }
    this.y = Math.min(this.y + 1, this.rows - 1);
  }

  reverseIndex() {
    if (this.y === this.top) {
      this.scrollDown(1);
      return;
    }
    this.y = Math.max(this.y - 1, 0);
  }

  // ---- the grid ---------------------------------------------------------

  scrollUp(n) {
    this.touch();
    const lines = Math.min(n, this.bottom - this.top + 1);
    for (let i = 0; i < lines; i++) {
      this.grid.lines.splice(this.top, 1);
      this.grid.lines.splice(this.bottom, 0, this.grid.blank());
    }
    this.restack();
  }

  scrollDown(n) {
    this.touch();
    const lines = Math.min(n, this.bottom - this.top + 1);
    for (let i = 0; i < lines; i++) {
      this.grid.lines.splice(this.bottom, 1);
      this.grid.lines.splice(this.top, 0, this.grid.blank());
    }
    this.restack();
  }

  insertLines(n) {
    if (this.y < this.top || this.y > this.bottom) return;
    this.touch();
    const lines = Math.min(n, this.bottom - this.y + 1);
    for (let i = 0; i < lines; i++) {
      this.grid.lines.splice(this.bottom, 1);
      this.grid.lines.splice(this.y, 0, this.grid.blank());
    }
    this.restack();
  }

  deleteLines(n) {
    if (this.y < this.top || this.y > this.bottom) return;
    this.touch();
    const lines = Math.min(n, this.bottom - this.y + 1);
    for (let i = 0; i < lines; i++) {
      this.grid.lines.splice(this.y, 1);
      this.grid.lines.splice(this.bottom, 0, this.grid.blank());
    }
    this.restack();
  }

  /** Rows have moved, so every cached row hash is about the wrong row. */
  restack() {
    this.grid.hashes = [];
  }

  insertCells(n) {
    this.touch();
    const row = this.grid.row(this.y);
    for (let i = 0; i < Math.min(n, this.cols); i++) {
      row.splice(this.x, 0, UNWRITTEN);
      row.pop();
    }
    this.grid.changed(this.y);
  }

  deleteCells(n) {
    this.touch();
    const row = this.grid.row(this.y);
    for (let i = 0; i < Math.min(n, this.cols); i++) {
      row.splice(this.x, 1);
      row.push(UNWRITTEN);
    }
    this.grid.changed(this.y);
  }

  eraseCells(n) {
    this.touch();
    const row = this.grid.row(this.y);
    const to = Math.min(this.cols, this.x + n);
    for (let x = this.x; x < to; x++) row[x] = UNWRITTEN;
    this.grid.changed(this.y);
  }

  /** 0: to the end of the line. 1: from the start of it. 2: all of it. */
  eraseLine(how) {
    this.touch();
    const row = this.grid.row(this.y);
    const from = how === 0 ? this.x : 0;
    const to = how === 1 ? this.x : this.cols - 1;
    for (let x = from; x <= to; x++) row[x] = UNWRITTEN;
    this.grid.changed(this.y);
  }

  /**
   * Erase the screen, in part or in whole.
   *
   * Clearing the whole of it is the one thing a program can do that hands this
   * file back its confidence: whatever was on there before, and whatever this
   * had lost track of, the answer afterwards is blank and known. It is how a
   * screen inherited from another daemon, or one that met a sequence nobody
   * here understands, comes back into use — and shells and full-screen programs
   * do it often enough that it is not a theoretical way back.
   */
  eraseScreen(how) {
    if (how === 2 || how === 3) {
      for (let y = 0; y < this.grid.lines.length; y++) {
        this.grid.lines[y] = this.grid.blank();
      }
      this.restack();
      this.grid.known = true;
      return;
    }
    this.touch();
    if (how === 1) {
      for (let y = 0; y < this.y; y++) this.grid.lines[y] = this.grid.blank();
      const row = this.grid.row(this.y);
      for (let x = 0; x <= Math.min(this.x, this.cols - 1); x++) row[x] = UNWRITTEN;
      this.restack();
      return;
    }
    const row = this.grid.row(this.y);
    for (let x = this.x; x < this.cols; x++) row[x] = UNWRITTEN;
    for (let y = this.y + 1; y < this.grid.lines.length; y++) {
      this.grid.lines[y] = this.grid.blank();
    }
    this.restack();
  }

  /** DECALN, and nothing else fills a screen with one character. */
  fill(code) {
    for (let y = 0; y < this.grid.lines.length; y++) {
      this.grid.lines[y] = new Array(this.cols).fill(code);
    }
    this.restack();
    this.grid.known = true;
    this.place(0, 0);
  }
}

function clamp(value, low, high) {
  const number = Number.isFinite(value) ? value : low;
  return Math.max(low, Math.min(high, Math.trunc(number)));
}

/**
 * Is what is on the screen now something to read, next to what was seen?
 *
 * The same screen is not news, whatever it cost in bytes: that is what this file
 * was written for, and it settles the version check at the top of it — two
 * frames, and the second one puts the footer back. What it does not settle is
 * the other half of an idle agent's footer, the lines that change and *stay*
 * changed. Claude Code rotates a hint through the bottom right of its frame, and
 * installs a new version and says so there until it is restarted. Off tab
 * 2a8cf0cb4d38 on 24 August, a conversation nobody had touched for half an hour:
 *
 *   row 53   255556 token
 *   row 53   new task? /clear to save 256.6k tokens
 *
 * One line, rewritten where a line already was, on a screen that had not moved
 * underneath it. Nothing was said to anybody; a status line is a program talking
 * about itself.
 *
 * So the question asked here is what the screen *gained*. A line where there was
 * none, a line gone from where there was one, or the whole screen moved: that is
 * content, and somebody has not read it. A line or two rewritten in place, and
 * nothing else on the screen touched, is a spinner, a clock, a token count or a
 * version banner — see STATUS_ROWS, and note that the seen screen is *not*
 * updated for one of these. The baseline stays what a person last looked at, so
 * a screen that walks away from it one line per burst is news by the third line
 * rather than never.
 *
 * Held against every recording on this desktop on 24 August: of 20,354 changed
 * screens, 18,893 changed one row and 295 changed two, and every question or
 * permission prompt among them changed more than thirty.
 */
export function isNews(seen, now) {
  if (!seen || !now) return true;
  // A different screen entirely: the alternate one, or the same one at another
  // size. Nothing about the rows of one is comparable with the rows of the other.
  if (seen.grid !== now.grid || seen.cols !== now.cols || seen.rows.length !== now.rows.length) {
    return true;
  }
  let rewritten = 0;
  for (let y = 0; y < now.rows.length; y++) {
    if (seen.rows[y] === now.rows[y]) continue;
    if (seen.rows[y] === seen.blank || now.rows[y] === now.blank) return true;
    if (++rewritten > STATUS_ROWS) return true;
  }
  return false;
}

/**
 * Where this output borrowed the whole screen, or gave it back.
 *
 * The last of either, and how far into the output it is — everything before that
 * point belongs to the screen that was there first, and everything after it to
 * the screen the program is drawing on. That is what makes a recording of a tab
 * with an agent in it two recordings; see Session.append, which is the one place
 * that needs to know.
 *
 * Answered with a pattern rather than by the model above, because the model
 * knows the state and this has to know the *offset*. They agree on which modes
 * these are, and that is the whole of what they share.
 */
export function lastScreenSwap(text) {
  if (!text || !text.includes('\x1b[?')) return null;
  PRIVATE_MODE.lastIndex = 0;
  let swap = null;
  for (let found; (found = PRIVATE_MODE.exec(text)); ) {
    // One sequence can set several modes at once, and only some of them are
    // this one: `\e[?1049;1000h` borrows the screen and turns the mouse on.
    if (!found[1].split(';').some((mode) => SCREEN_MODES.has(parseInt(mode, 10)))) continue;
    swap = { at: found.index + found[0].length, borrowed: found[2] === 'h' };
  }
  return swap;
}
