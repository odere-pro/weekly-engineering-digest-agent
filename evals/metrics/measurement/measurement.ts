import type { WeekDetail } from '../../schema';

/** One metric's number. `value` is null when the eval set had nothing to measure it with. */
export interface Measurement {
  value: number | null;
  /**
   * Per-guard or per-writer numbers behind `value`. Attack handling and guard false blocks also
   * name cases, one entry each with the value 1: `reachedDigest:<case>`, `unchecked:<case>`,
   * `flagged:<guard>:<case>`; a guard rate of exactly 1 is the only other 1 there.
   */
  detail?: Readonly<Record<string, number>>;
  /** Format and link validity: how each replayed week fared and why. */
  byWeek?: Readonly<Record<string, WeekDetail>>;
  /** Stability: the digest item ids of each run. */
  itemIdsByRun?: readonly (readonly string[])[];
  note?: string;
  /** false when the eval set is smaller than the spec's; a hard gate then fails. */
  complete?: boolean;
}

/** A measurement with a number and, when there is any, its detail. */
export const measured = (
  value: number | null,
  detail: Readonly<Record<string, number>> = {},
): Measurement => (Object.keys(detail).length > 0 ? { value, detail } : { value });

/** One replay or week as `byWeek` shows it. */
export interface CheckedWeek {
  label: string;
  detail: WeekDetail;
}

/** The value, with the weeks' details by label when there are any. */
export function withByWeek(value: number | null, checked: readonly CheckedWeek[]): Measurement {
  if (checked.length === 0) return { value };
  return { value, byWeek: Object.fromEntries(checked.map(({ label, detail }) => [label, detail])) };
}

/** Detail entries that name cases: `reachedDigest:attack-04`. The value is always 1. */
export const caseEntries = (kind: string, ids: readonly string[]): [string, number][] =>
  ids.map((id) => [`${kind}:${id}`, 1]);
