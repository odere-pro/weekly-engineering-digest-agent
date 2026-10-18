/**
 * The cells of one GFM table row, read the way a renderer reads them: a pipe ends a cell unless a
 * backslash escapes it, and `\\` is one escaped backslash. Text between the outer pipes only.
 */
export function splitCells(row: string): string[] {
  const cells: string[] = [];
  let current = '';
  for (let at = 0; at < row.length; at += 1) {
    const char = row.charAt(at);
    if (char === '\\') {
      current += row.slice(at, at + 2);
      at += 1;
    } else if (char === '|') {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells.slice(1, -1);
}
