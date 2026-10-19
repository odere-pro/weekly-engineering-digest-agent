import { printableLine, truncate } from '../../../shared/text';

const COLUMN_GAP = '  ';
export const MAX_CELL_CHARS = 70;
const SCORE_DECIMALS = 1;
/** Control and format characters have no place in a terminal; a text keeps its line breaks and tabs. */
const UNPRINTABLE_IN_TEXT = /[^\P{Cc}\n\t\r]|\p{Cf}/gu;

/** One table cell: a printable line (see `printableLine`), cut when long. */
export function cell(text: string): string {
  return truncate(printableLine(text), MAX_CELL_CHARS);
}

/** The text with its control and format characters removed; line breaks and tabs stay. */
export function clean(text: string): string {
  return text.replace(UNPRINTABLE_IN_TEXT, '');
}

/** A score with one decimal. */
export function formatScore(value: number): string {
  return value.toFixed(SCORE_DECIMALS);
}

/** Rows of cells as padded columns; the first row is the header. No trailing spaces. */
export function table(rows: readonly (readonly string[])[]): string {
  const [header = []] = rows;
  const widths = header.map((_, col) => Math.max(...rows.map((row) => (row[col] ?? '').length)));
  return `${rows
    .map((row) =>
      row
        .map((text, col) => text.padEnd(widths[col] ?? 0))
        .join(COLUMN_GAP)
        .trimEnd(),
    )
    .join('\n')}\n`;
}
