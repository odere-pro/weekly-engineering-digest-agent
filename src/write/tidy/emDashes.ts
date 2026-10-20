/**
 * Feed titles carry em dashes the format check rejects. A run of them, with the spaces and
 * commas around it, becomes one comma; at either end of a field it is dropped.
 */
const EM_DASH_RUN = /(?:(?<![\s,])[\s,]+)?\u2014[\s,\u2014]*/g;
const EM_DASH_REPLACEMENT = ', ';

export function withoutEmDashes(text: string): string {
  return text.replace(EM_DASH_RUN, (run: string, offset: number) =>
    offset === 0 || offset + run.length === text.length ? '' : EM_DASH_REPLACEMENT,
  );
}
