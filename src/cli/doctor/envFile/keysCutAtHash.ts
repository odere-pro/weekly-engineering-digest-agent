/** node:util parseEnv reads an unquoted value up to its first "#". */
const ENV_ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*=(.*)$/;
const ENV_QUOTES: ReadonlySet<string> = new Set(['"', "'", '`']);

/**
 * Each key (first line only) whose unquoted value contains a "#". The parser ends a quoted value
 * at the next same quote character, on a later line if need be, and keeps a quote that nothing
 * closes as plain text; the scan does the same, so it never skips lines the parser reads.
 * Only the key and the 1-based line leave this function, never the value.
 */
export function keysCutAtHash(text: string): { key: string; line: number }[] {
  const found = new Map<string, number>();
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const [, key, rest] = ENV_ASSIGNMENT.exec(lines[index] ?? '') ?? [];
    if (key === undefined || rest === undefined) continue;
    const value = rest.trimStart();
    const quote = value.charAt(0);
    if (!ENV_QUOTES.has(quote)) {
      if (value.includes('#') && !found.has(key)) found.set(key, index + 1);
      continue;
    }
    const afterQuote = [value.slice(1), ...lines.slice(index + 1)].join('\n');
    const closeAt = afterQuote.indexOf(quote);
    if (closeAt !== -1) index += afterQuote.slice(0, closeAt).split('\n').length - 1;
  }
  return [...found].map(([key, line]) => ({ key, line }));
}
