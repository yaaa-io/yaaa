/**
 * Text from the API (product titles, descriptions, store names, alert bodies, error messages) as it's safe to print
 * in a terminal. Stores write that text, so before the rich views show it, this removes what a terminal would act
 * on rather than print: escape sequences (colours, cursor moves, screen clears, OSC 8 links, OSC 52 clipboard
 * writes), every other C0 and C1 control character and DEL, and the bidi controls that reorder how text reads
 * (U+061C, U+200E, U+200F, U+202A to U+202E, U+2066 to U+2069). --json output keeps the API's text as it is.
 */

// CSI: ESC [ (or the 8-bit C1 CSI) parameters, intermediates, a final byte.
const CSI = /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g;
// OSC, DCS, SOS, PM and APC strings: ESC ] P X ^ _ (or their C1 forms) up to BEL or ST, or to the end when unended.
const STRING_SEQ = /(?:\x1b[\]PX^_]|[\x90\x98\x9d\x9e\x9f])[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c|$)/g;
// Any other escape: ESC and the one character after it.
const OTHER_ESC = /\x1b[\s\S]?/g;
// Bidi embedding, override and isolate controls, and the marks that reorder neutral characters.
const BIDI = /[؜‎‏‪-‮⁦-⁩]/g;
// C0 except tab and newline, DEL, and C1.
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

function strip(s: string): string {
  return s.replace(STRING_SEQ, '').replace(CSI, '').replace(OTHER_ESC, '').replace(BIDI, '').replace(CONTROL, '');
}

/** One line of server text, safe to print: tabs and line breaks become spaces, controls are removed. */
export function clean(s: string | undefined | null): string {
  if (!s) return '';
  return strip(s.replace(/\r\n?|\n|\t/g, ' '));
}

/** Server text that keeps its line breaks (for views that wrap it); tabs become spaces, other controls are removed. */
export function cleanLines(s: string | undefined | null): string {
  if (!s) return '';
  return strip(s.replace(/\r\n?/g, '\n').replace(/\t/g, ' '));
}
