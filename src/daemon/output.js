/*
 * Did anything appear on the screen?
 *
 * A tab goes red when it produces output while nobody is looking at it, and
 * the red means "there is something in here to read". Not everything a program
 * writes is something to read. A full-screen agent sitting at its own prompt,
 * touched by nobody, still resets the charset, turns mouse reporting back on,
 * asks the terminal what colour its background is and renames its own tab —
 * and every one of those is bytes out of a pty with nothing to show for it.
 *
 * On 17 August a tab holding an idle Claude Code wrote exactly this and went
 * red for it:
 *
 *   \e(B \x0f \e[?1000h \e[?1002h \e[?1003h \e[?1006h
 *
 * Thirty-six bytes, an ASCII charset and mouse reporting back on, not one
 * character of it visible. On a desktop with thirteen agents on it, a colour
 * that means "your turn" and a colour that means "an agent re-asserted a
 * terminal mode" cannot be the same colour.
 *
 * So the question asked here is the narrow one: take out everything that
 * cannot change what is on the screen, and see whether anything is left.
 */

/*
 * All of these draw nothing.
 *
 * OSC goes first because its terminator is a BEL, and a BEL on its own is
 * something to hear about — a program ringing the bell is exactly the kind of
 * "look at me" this flag is for, and it must not be eaten as the tail of a
 * title somebody set.
 */
const INVISIBLE = [
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, // OSC: titles, colour queries, colour replies
  /\x1bP[^\x1b]*\x1b\\/g, // DCS: the terminal's answers about itself
  /\x1b\[\?[0-9;]*[hl]/g, // private modes: mouse, bracketed paste, focus, cursor, sync
  /\x1b\[\?[0-9;]*\$[a-z]/g, // and the replies about which of them are set
  /\x1b\[[>=][0-9;]*[a-zA-Z]/g, // device attributes, XTVERSION, XTMODKEYS
  /\x1b\[[0-9;]*[cnq]/g, // asking what the terminal is, and how it is doing
  /\x1b\[[0-9;]*m/g, // colour: nothing appears until something is drawn in it
  /\x1b\[[0-9;]*[ABCDEFGHIZdefgr]/g, // moving the cursor about, and the scrolling region
  /\x1b\[[su]/g, // saving and restoring where it was
  /\x1b[()*+][A-Za-z0-9]/g, // charset selection
  /\x1b[78=><Fclmno|}~]/g, // cursor save/restore, keypad, and the other one-byte escapes
  /[\x0e\x0f]/g, // shift out, shift in
];

/**
 * True when this output could have changed what somebody would see.
 *
 * What survives the list above is text, an erase, an insert, a scroll, a line
 * feed or a bell — the things that leave a mark. Cursor movement on its own
 * does not: a program that moves to a corner and draws nothing has drawn
 * nothing, and a program that moves and *then* draws still has the drawing in
 * here.
 */
export function drawsSomething(text) {
  if (!text) return false;
  let rest = String(text);
  for (const pattern of INVISIBLE) rest = rest.replace(pattern, '');
  return rest.length > 0;
}
