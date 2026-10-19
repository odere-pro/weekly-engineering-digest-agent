// Text a model or a feed wrote, made safe to print on one line of the scorecard.
import { truncate } from '../../../shared/text';

/** Printing keeps a scorecard to a screen; the JSON file keeps the problems it stored. */
export const MAX_PRINTED_PROBLEM_CHARS = 120;

/**
 * Text a model wrote must not move the cursor, recolor the terminal or reorder what is read:
 * control characters (incl. escapes, newlines, C1), line and paragraph separators, zero-width
 * and bidirectional marks, and tag characters.
 */
const UNSAFE_TEXT =
  /[\p{Cc}\u{2028}\u{2029}\u{200B}-\u{200F}\u{202A}-\u{202E}\u{2066}-\u{2069}\u{E0000}-\u{E007F}]+/gu;

/** Model-written text as one printable line: unsafe characters become a space; cut when long. */
export function safeText(text: string): string {
  return text.replace(UNSAFE_TEXT, ' ').trim();
}

/** `safeText`, cut to `MAX_PRINTED_PROBLEM_CHARS` at a word boundary without splitting an emoji. */
export function oneLine(text: string): string {
  return truncate(safeText(text), MAX_PRINTED_PROBLEM_CHARS);
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
