
const OSC_TITLE = /\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

const PARTIAL = /\x1b(?:\](?:[02](?:;[^\x07\x1b]*)?)?)?$/;

const MAX_PARTIAL = 4096;

export function lastTitleIn(text) {
  return new TitleReader().read(String(text ?? ''));
}

export class TitleReader {
  constructor() {
    this.carry = '';
  }

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
