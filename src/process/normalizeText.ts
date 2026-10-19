/**
 * Unicode-folded, lowercase, with runs of anything but letters, digits, `+` and `#` collapsed to
 * one space. The one comparison key for titles, product names and areas.
 */
export function normalizeText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#]+/gu, ' ')
    .trim();
}
