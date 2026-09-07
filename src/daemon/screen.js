
const UNWRITTEN = 0;
const SPACE = 0x20;

const MAX_PARTIAL = 4096;

const TAB = 8;

const MAX_COLS = 1000;
const MAX_ROWS = 500;

const STATUS_ROWS = 2;

const SCREEN_MODES = new Set([47, 1047, 1049]);
const PRIVATE_MODE = /\x1b\[\?([0-9;]*)([hl])/g;

const PLAIN = /[\x00-\x1f\x7f]/g;

const CSI = /\x1b\[([\x30-\x3f]*)([\x20-\x2f]*)([\x40-\x7e])/y;
const CSI_PARTIAL = /\x1b\[[\x30-\x3f]*[\x20-\x2f]*$/y;
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/y;
const OSC_PARTIAL = /\x1b\][^\x07\x1b]*\x1b?$/y;
const STRING = /\x1b([P_^X])([^\x1b]*)\x1b\\/y;
const STRING_PARTIAL = /\x1b[P_^X][^\x1b]*\x1b?$/y;

const HASH_SEED = 0x811c9dc5;
const HASH_PRIME = 0x01000193;

function mix(hash, value) {
  return Math.imul(hash ^ value, HASH_PRIME) >>> 0;
}

function hashRow(cells, cols) {
  let hash = HASH_SEED;
  for (let x = 0; x < cols; x++) {
    const cell = cells[x];
    hash = mix(hash, cell === UNWRITTEN ? SPACE : cell);
  }
  return hash;
}

const BLANK_ROWS = new Map();

function blankHash(cols) {
  let hash = BLANK_ROWS.get(cols);
  if (hash === undefined) {
    hash = hashRow(new Array(cols).fill(UNWRITTEN), cols);
    BLANK_ROWS.set(cols, hash);
  }
  return hash;
}

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
    this.pendingWrap = false;
    this.savedCursor = null;
    this.placed = known;
    this.carry = '';
  }

  get sure() {
    return this.grid.known;
  }

  forget() {
    this.grid.known = false;
    this.placed = false;
  }

  digest() {
    return `${this.grid === this.alt ? 'alt' : 'main'}:${this.grid.digest()}`;
  }

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
      PLAIN.lastIndex = i;
      const stop = PLAIN.exec(text) ? PLAIN.lastIndex - 1 : text.length;
      i = this.printRun(text, i, stop);
    }
  }

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
      case 0x08:
        this.pendingWrap = false;
        this.x = Math.max(0, this.x - 1);
        break;
      case 0x09:
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
        break;
    }
  }

  escape(text, at) {
    const next = text[at + 1];
    if (next === undefined) return 0;
    if (next === '[') return this.csi(text, at);
    if (next === ']') return this.osc(text, at);
    if (next === 'P' || next === '_' || next === '^' || next === 'X') {
      return this.string(text, at);
    }
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
      case 'D':
        this.lineFeed();
        return 2;
      case 'E':
        this.x = 0;
        this.lineFeed();
        return 2;
      case 'M':
        this.reverseIndex();
        return 2;
      case 'H':
      case '=':
      case '>':
      case '\\':
      case 'Z':
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

    const count = (i) => {
      const value = parseInt(args[i], 10);
      return Number.isFinite(value) && value > 0 ? Math.min(value, MAX_ROWS * MAX_COLS) : 1;
    };
    const choice = (i) => {
      const value = parseInt(args[i], 10);
      return Number.isFinite(value) && value > 0 ? value : 0;
    };

    const inter = found[2];
    if (inter) {
      if (!'mnqtx'.includes(final) && !(final === 'p' && inter !== '!')) this.forget();
      return took;
    }

    const erase = priv === '?' && (final === 'J' || final === 'K');

    if (priv && !erase && final !== 'h' && final !== 'l') {
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
      case 'm':
      case 'n':
      case 'c':
      case 'q':
      case 'g':
      case 'i':
      case 'p':
      case 't':
      case 'x':
        break;
      default:
        this.forget();
        break;
    }
    return took;
  }

  mode(priv, args, set) {
    for (const arg of args) {
      const which = parseInt(arg, 10);
      if (!Number.isFinite(which)) continue;
      if (priv === '?') {
        if (which === 7) this.autowrap = set;
        else if (which === 47 || which === 1047 || which === 1049) this.alternate(set);
        else if (which === 6) this.forget();
      } else if (which === 4) {
        this.forget();
      }
    }
  }

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

  touch() {
    if (!this.placed) this.grid.known = false;
  }

  moveTo(x, y) {
    this.pendingWrap = false;
    this.x = clamp(x, 0, this.cols - 1);
    this.y = clamp(y, 0, this.rows - 1);
  }

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

  eraseLine(how) {
    this.touch();
    const row = this.grid.row(this.y);
    const from = how === 0 ? this.x : 0;
    const to = how === 1 ? this.x : this.cols - 1;
    for (let x = from; x <= to; x++) row[x] = UNWRITTEN;
    this.grid.changed(this.y);
  }

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

export function isNews(seen, now) {
  if (!seen || !now) return true;
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

export function lastScreenSwap(text) {
  if (!text || !text.includes('\x1b[?')) return null;
  PRIVATE_MODE.lastIndex = 0;
  let swap = null;
  for (let found; (found = PRIVATE_MODE.exec(text)); ) {
    if (!found[1].split(';').some((mode) => SCREEN_MODES.has(parseInt(mode, 10)))) continue;
    swap = { at: found.index + found[0].length, borrowed: found[2] === 'h' };
  }
  return swap;
}
