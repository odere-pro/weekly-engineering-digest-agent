/** One labeled value and what was predicted for it. */
export interface RankPair {
  expected: number;
  actual: number;
}

/** Rank from 1 of `value` among `values`, a tie getting the mean of the ranks it spans. */
function rankIn(value: number, values: readonly number[]): number {
  const below = values.filter((other) => other < value).length;
  const upToValue = values.filter((other) => other <= value).length;
  return (below + upToValue + 1) / 2;
}

/** Spearman rank correlation; null when fewer than two pairs or one side has no spread. */
export function spearman(pairs: readonly RankPair[]): number | null {
  if (pairs.length < 2) return null;
  const expected = pairs.map((p) => p.expected);
  const actual = pairs.map((p) => p.actual);
  const ranked = pairs.map((p) => ({
    x: rankIn(p.expected, expected),
    y: rankIn(p.actual, actual),
  }));
  const mx = ranked.reduce((sum, r) => sum + r.x, 0) / ranked.length;
  const my = ranked.reduce((sum, r) => sum + r.y, 0) / ranked.length;
  const cross = ranked.reduce((sum, r) => sum + (r.x - mx) * (r.y - my), 0);
  const spreadX = ranked.reduce((sum, r) => sum + (r.x - mx) ** 2, 0);
  const spreadY = ranked.reduce((sum, r) => sum + (r.y - my) ** 2, 0);
  return spreadX === 0 || spreadY === 0 ? null : cross / Math.sqrt(spreadX * spreadY);
}
