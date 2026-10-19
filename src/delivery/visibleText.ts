import { printableLine } from '../shared/text';
import { EMOJI_JOINER, ZERO_WIDTH_JOINER } from './visibleLine';

const NOT_INDENTATION = /[^ \t]/;

/**
 * One line of a text without its invisible characters. The indentation the line was written with
 * stays (a nested list item); every run of control and format characters inside it, a tab
 * included, becomes one space; a line break left over from `\r\n` and any trailing blanks go.
 * `printableLine` does the cleaning and trims both ends, so the indentation is set aside first.
 */
function cleanedLine(line: string): string {
  const contentAt = line.search(NOT_INDENTATION);
  if (contentAt < 0) return '';
  const rest = printableLine(line.slice(contentAt));
  return rest === '' ? '' : `${line.slice(0, contentAt)}${rest}`;
}

/** A stretch with no kept joiner in it, cleaned line by line. */
function cleanedPart(part: string): string {
  return part.split('\n').map(cleanedLine).join('\n');
}

/**
 * Model or collected text that keeps its line breaks (the Markdown fallback Slack gets when a
 * message has no view), as a reader sees it written: every run of control and invisible format
 * characters (bidi marks, overrides and isolates, zero-width and tag characters, the byte order
 * mark, the soft hyphen) becomes one space, so the text cannot reorder or hide what is shown
 * around it. `\n` is the only control character that stays; trailing blanks per line are trimmed.
 *
 * It is `visibleLine` for text with lines: a zero-width joiner between two emoji stays (the same
 * `EMOJI_JOINER`), so a joined emoji arrives whole; the text is cut at each kept joiner and the
 * parts are cleaned alone, so a joiner next to any other invisible character, or across a line
 * break, goes too. Every step is linear, so hostile input stays fast.
 */
export function visibleText(text: string): string {
  return text.split(EMOJI_JOINER).map(cleanedPart).join(ZERO_WIDTH_JOINER);
}
