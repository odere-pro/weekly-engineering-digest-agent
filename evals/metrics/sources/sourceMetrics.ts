import type { SourceResult } from '../../sourceEval';
import type { Measurement } from '../measurement/measurement';
import { EPSILON } from '../measurement/numbers';

/** The gate for `sourceParse` (items parsed over items expected): `GATES` in `metrics.ts` reads it. */
export const SOURCE_PARSE_MIN = 0.95;
/** The gate for `sourceSummaryFill` (parsed items with a real summary): `GATES` reads it too. */
export const SOURCE_SUMMARY_FILL_MIN = 0.9;

interface SourceCounts {
  sourceId: string;
  good: number;
  total: number;
}

/** Pooled ratio, a ratio per source in `detail`, and the sources below `min` in the note. */
function sourceMeasurement(counts: readonly SourceCounts[], min: number): Measurement {
  const measuredSources = counts.filter(({ total }) => total > 0);
  const total = measuredSources.reduce((sum, c) => sum + c.total, 0);
  if (total === 0) return { value: null };
  const ratios = measuredSources.map((c) => [c.sourceId, Math.min(1, c.good / c.total)] as const);
  const below = ratios.filter(([, ratio]) => ratio < min - EPSILON);
  return {
    value: Math.min(1, measuredSources.reduce((sum, c) => sum + c.good, 0) / total),
    detail: Object.fromEntries(ratios),
    ...(below.length > 0 ? { note: `below the gate: ${below.map(([id]) => id).join(', ')}` } : {}),
  };
}

/** Items parsed over items expected, over every recorded source. */
export function sourceParse(results: readonly SourceResult[]): Measurement {
  const measurement = sourceMeasurement(
    results.map((r) => ({ sourceId: r.sourceId, good: r.parsed, total: r.expected })),
    SOURCE_PARSE_MIN,
  );
  const threw = results.filter((r) => r.error !== undefined).map((r) => r.sourceId);
  if (threw.length === 0) return measurement;
  const note = [measurement.note, `fetcher failed: ${threw.join(', ')}`]
    .filter((part): part is string => part !== undefined)
    .join('; ');
  return { ...measurement, note };
}

/** Parsed items with a real summary (`MIN_SUMMARY_CHARS` in `sourceEval.ts`) over items parsed. */
export function sourceSummaryFill(results: readonly SourceResult[]): Measurement {
  return sourceMeasurement(
    results.map((r) => ({
      sourceId: r.sourceId,
      good: r.parsed - r.emptySummary,
      total: r.parsed,
    })),
    SOURCE_SUMMARY_FILL_MIN,
  );
}
