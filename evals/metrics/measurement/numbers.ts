/** Absorbs floating-point noise when a value sits exactly on a threshold. */
export const EPSILON = 1e-9;

/** `hits` out of `total`; null when there is nothing to divide by. */
export function share(hits: number, total: number): number | null {
  return total === 0 ? null : hits / total;
}

/** Arithmetic mean; null for no values. */
export function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** How often each id occurs. Safe for ids that look like object properties (`constructor`). */
export function countBy(ids: readonly string[]): Record<string, number> {
  return ids.reduce<Record<string, number>>(
    (counts, id) => ({ ...counts, [id]: (Object.hasOwn(counts, id) ? (counts[id] ?? 0) : 0) + 1 }),
    {},
  );
}
