// Grid search over one or more thresholds (W3-03). No files, no model calls.
import { EPSILON } from './measures';

/** Grid steps on each side of the chosen point that should score as well as it does. */
export const MARGIN_STEPS = 2;
const GRID_PRECISION = 1e6;

export interface Axis {
  min: number;
  max: number;
  step: number;
}

export const RELEVANCE_AXIS: Axis = { min: 0, max: 3, step: 0.05 };
export const PROBABILITY_AXIS: Axis = { min: 0, max: 1, step: 0.05 };

/** Every grid value from min to max, rounded so 0.05 steps land on 0.15, not 0.15000000000000002. */
export function axisValues(axis: Axis): number[] {
  const count = Math.round((axis.max - axis.min) / axis.step) + 1;
  return Array.from(
    { length: count },
    (_, i) => Math.round((axis.min + i * axis.step) * GRID_PRECISION) / GRID_PRECISION,
  );
}

function cartesian<T>(lists: readonly (readonly T[])[]): T[][] {
  return lists.reduce<T[][]>(
    (tuples, list) => tuples.flatMap((tuple) => list.map((value) => [...tuple, value])),
    [[]],
  );
}

const mean = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

/** One threshold to search: its grid values and the value in use. */
export interface GridDimension {
  values: readonly number[];
  preferred: number;
}

export interface GridPick<K extends string> {
  point: Record<K, number>;
  score: number;
}

/** One grid value of one dimension. */
interface Coordinate<K extends string> {
  key: K;
  dim: GridDimension;
  index: number;
  value: number;
}

interface Candidate<K extends string> {
  coordinates: readonly Coordinate<K>[];
  /** Mean score of the grid points within MARGIN_STEPS on every axis, clipped at the edges. */
  margin: number;
  /** Distance to the preferred point, each axis scaled to 0-1. */
  distance: number;
}

const isBetter = <K extends string>(a: Candidate<K>, b: Candidate<K>): boolean =>
  a.margin > b.margin + EPSILON ||
  (Math.abs(a.margin - b.margin) <= EPSILON && a.distance < b.distance - EPSILON);

function pointOf<K extends string>(coordinates: readonly Coordinate<K>[]): Record<K, number> {
  // fromEntries loses the key type; every key is in `coordinates` by construction.
  return Object.fromEntries(coordinates.map((c) => [c.key, c.value])) as Record<K, number>;
}

/** Scaled distance between `value` and the preferred value on its dimension (0 on a one-value axis). */
function scaledDistance({ dim, value }: Coordinate<string>): number {
  const span = Math.max(...dim.values) - Math.min(...dim.values);
  return span === 0 ? 0 : Math.abs(value - dim.preferred) / span;
}

/** The grid values within MARGIN_STEPS of `c` on its own dimension. */
function around<K extends string>(c: Coordinate<K>): Coordinate<K>[] {
  const from = Math.max(0, c.index - MARGIN_STEPS);
  return c.dim.values
    .slice(from, c.index + MARGIN_STEPS + 1)
    .map((value, offset) => ({ ...c, index: from + offset, value }));
}

/**
 * The grid point with the best score. Ties go to the point whose neighbours score best, so a
 * small shift in model probabilities does not change the outcome, then to the point closest to
 * the preferred values (the thresholds in use), so nothing moves further than the data asks.
 */
export function pickOnGrid<K extends string>(
  dims: Readonly<Record<K, GridDimension>>,
  score: (point: Readonly<Record<K, number>>) => number,
): GridPick<K> {
  const memo = new Map<string, number>();
  const scoreOf = (coordinates: readonly Coordinate<K>[]): number => {
    const key = coordinates.map((c) => c.index).join();
    const known = memo.get(key);
    if (known !== undefined) return known;
    const value = score(pointOf(coordinates));
    memo.set(key, value);
    return value;
  };
  const entries = Object.entries(dims) as [K, GridDimension][];
  const points = cartesian(
    entries.map(([key, dim]) => dim.values.map((value, index) => ({ key, dim, index, value }))),
  );
  const best = points.reduce((max, point) => Math.max(max, scoreOf(point)), -Infinity);
  const candidates = points
    .filter((point) => scoreOf(point) >= best - EPSILON)
    .map((coordinates): Candidate<K> => ({
      coordinates,
      margin: mean(cartesian(coordinates.map(around)).map(scoreOf)),
      distance: coordinates.reduce((sum, c) => sum + scaledDistance(c), 0),
    }));
  const chosen = candidates.reduce((a, b) => (isBetter(b, a) ? b : a));
  return { point: pointOf(chosen.coordinates), score: best };
}
