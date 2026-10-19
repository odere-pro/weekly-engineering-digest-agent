/** The text on one line: every run of whitespace, line breaks included, becomes one space. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** `1 item`, `2 items`. */
export function pluralizeItems(count: number): string {
  return `${count} ${count === 1 ? 'item' : 'items'}`;
}
