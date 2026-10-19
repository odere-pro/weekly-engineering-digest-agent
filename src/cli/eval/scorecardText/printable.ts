// Text a model or a feed wrote, made safe to print on one line of the scorecard.
import { printableLine, truncate } from '../../../shared/text';

/** Printing keeps a scorecard to a screen; the JSON file keeps the problems it stored. */
export const MAX_PRINTED_PROBLEM_CHARS = 120;

/**
 * Model-written text as one printable line: it must not move the cursor, recolor the terminal or
 * reorder what is read, so control, format and separator characters become a space; cut when long.
 */
export function safeText(text: string): string {
  return printableLine(text);
}

/** `safeText`, cut to `MAX_PRINTED_PROBLEM_CHARS` at a word boundary without splitting an emoji. */
export function oneLine(text: string): string {
  return truncate(safeText(text), MAX_PRINTED_PROBLEM_CHARS);
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
