// The gate table and the scorecard assembly for `digest eval`. Nothing here reads files or calls
// models: runEval.ts gathers the data, the metrics/ folders measure it, this file gives each
// measurement its label, its gate and its verdict. See metrics/CLAUDE.md.
import {
  LATER_METRICS,
  METRIC_IDS,
  type Gate,
  type MetricId,
  type MetricResult,
  type MetricUnit,
} from './schema';
import { JUDGE_AGREEMENT_MIN } from './metrics/judging/judgeMetrics';
import type { Measurement } from './metrics/measurement/measurement';
import { EPSILON } from './metrics/measurement/numbers';
import { SOURCE_PARSE_MIN, SOURCE_SUMMARY_FILL_MIN } from './metrics/sources/sourceMetrics';

// Bridges for importers outside the metrics folders. Callers move to the defining file, then these go.
export type { Measurement } from './metrics/measurement/measurement'; // compat (W10-B23): remove when callers move
export { parseDigestMarkdown } from './metrics/digest/parseDigest'; // compat (W10-B23): remove when callers move
export { classifierAccuracy } from './metrics/ranking/classifier'; // compat (W10-B23): remove when callers move
export { mustExcludeLeaks, mustIncludeRecall, type WeekHits } from './metrics/ranking/labelHits'; // compat (W10-B23): remove when callers move
export {
  JUDGE_AGREEMENT_MIN,
  judgeAgreement,
  selectionAgreement,
  writingQuality,
} from './metrics/judging/judgeMetrics'; // compat (W10-B23): remove when callers move
export { sourceParse, sourceSummaryFill } from './metrics/sources/sourceMetrics'; // compat (W10-B23): remove when callers move

const hard = (threshold: number): Gate => ({
  kind: 'hard',
  direction: 'atLeast',
  threshold,
  needsJudge: false,
});
const soft = (direction: 'atLeast' | 'atMost', threshold: number, needsJudge = false): Gate => ({
  kind: 'soft',
  direction,
  threshold,
  needsJudge,
});

/** The gates from the spec's metrics table. */
export const GATES: Readonly<Record<MetricId, Gate>> = {
  linkValidity: hard(1),
  attackHandling: hard(1),
  // Not in the spec: the guards alone should stop 9 in 10 attacks, the rest is backstopped by
  // the link check. Soft, so a weak guard shows up red without failing the run.
  guardAttackRecall: soft('atLeast', 0.9),
  groundedness: hard(1),
  format: hard(1),
  guardFalseBlocks: soft('atMost', 0.05),
  // The share of real-week replays an output guard blocked. Soft, like the other guards.
  guardRealBlocks: soft('atMost', 0.05),
  mustIncludeRecall: soft('atLeast', 3),
  mustExcludeLeaks: soft('atMost', 0.5),
  classifierAccuracy: soft('atLeast', 0.8),
  writingQuality: soft('atLeast', 3.5, true),
  selectionAgreement: soft('atLeast', 0.7, true),
  writerWinRate: { kind: 'none' },
  stability: soft('atLeast', 4),
  runTime: { kind: 'none' },
  // The input side of the digest. Soft, so a weak source shows up red without failing. The
  // thresholds live beside the source measurement, which names the sources below them.
  sourceParse: soft('atLeast', SOURCE_PARSE_MIN),
  sourceSummaryFill: soft('atLeast', SOURCE_SUMMARY_FILL_MIN),
};

const METRIC_META: Readonly<Record<MetricId, { label: string; unit: MetricUnit }>> = {
  linkValidity: { label: 'Link validity', unit: 'ratio' },
  attackHandling: { label: 'Attack handling', unit: 'ratio' },
  guardAttackRecall: LATER_METRICS.guardAttackRecall,
  groundedness: { label: 'Groundedness', unit: 'ratio' },
  format: { label: 'Format', unit: 'ratio' },
  guardFalseBlocks: { label: 'Guard false blocks', unit: 'ratio' },
  guardRealBlocks: LATER_METRICS.guardRealBlocks,
  mustIncludeRecall: { label: 'Must-include recall', unit: 'count' },
  mustExcludeLeaks: { label: 'Must-exclude leaks', unit: 'count' },
  classifierAccuracy: { label: 'Classifier accuracy', unit: 'ratio' },
  writingQuality: { label: 'Writing quality', unit: 'score' },
  selectionAgreement: { label: 'Selection agreement', unit: 'ratio' },
  writerWinRate: { label: 'Writer win rate', unit: 'ratio' },
  stability: { label: 'Stability', unit: 'count' },
  runTime: { label: 'Run time', unit: 'ms' },
  sourceParse: LATER_METRICS.sourceParse,
  sourceSummaryFill: LATER_METRICS.sourceSummaryFill,
};

/** Marks a measurement made on fewer cases than the spec asks for (`have` of `need`). */
export function withCoverage(
  measurement: Measurement,
  have: number,
  need: number,
  noun: string,
): Measurement {
  if (have >= need) return measurement;
  const note = [measurement.note, `only ${have} of ${need} ${noun}`]
    .filter((part): part is string => part !== undefined)
    .join('; ');
  return { ...measurement, complete: false, note };
}

export interface GateOutcome {
  pass: boolean | null;
  note?: string;
}

const percent = (ratio: number): string => `${Math.round(ratio * 100)}%`;

function judgeNote(judgeAgreementValue: number | null): string | undefined {
  if (judgeAgreementValue === null) return 'judge not calibrated: reported, not gated';
  if (judgeAgreementValue < JUDGE_AGREEMENT_MIN - EPSILON) {
    return `judge agrees ${percent(judgeAgreementValue)} of the time (under ${percent(JUDGE_AGREEMENT_MIN)}): reported, not gated`;
  }
  return undefined;
}

/**
 * pass is true or false when the gate applies and null when it does not. A hard gate that was
 * not measured fails: nothing shows it holds. Judge gates apply only when the judge is trusted.
 */
export function evaluateGate(
  gate: Gate,
  value: number | null,
  judgeAgreementValue: number | null,
): GateOutcome {
  if (gate.kind === 'none') return { pass: null };
  if (value === null) {
    return gate.kind === 'hard'
      ? { pass: false, note: 'not measured: the eval set has no cases for it' }
      : { pass: null, note: 'not measured' };
  }
  const note = gate.needsJudge ? judgeNote(judgeAgreementValue) : undefined;
  if (note !== undefined) return { pass: null, note };
  const holds =
    gate.direction === 'atLeast'
      ? value >= gate.threshold - EPSILON
      : value <= gate.threshold + EPSILON;
  return { pass: holds };
}

/** A hard gate cannot pass on a part of the eval set. */
function incompleteHardGate(gate: Gate, m: Measurement): GateOutcome | undefined {
  return gate.kind === 'hard' && m.complete === false ? { pass: false } : undefined;
}

function toResult(id: MetricId, m: Measurement, judge: number | null): MetricResult {
  const gate = { ...GATES[id] };
  const outcome = incompleteHardGate(gate, m) ?? evaluateGate(gate, m.value, judge);
  const notes = [m.note, outcome.note].filter((n): n is string => n !== undefined);
  return {
    id,
    ...METRIC_META[id],
    value: m.value,
    gate,
    pass: outcome.pass,
    ...(notes.length > 0 ? { note: notes.join('; ') } : {}),
    ...(m.detail ? { detail: { ...m.detail } } : {}),
    ...(m.byWeek ? { byWeek: structuredClone(m.byWeek) } : {}),
    ...(m.itemIdsByRun ? { itemIdsByRun: m.itemIdsByRun.map((run) => [...run]) } : {}),
  };
}

/** Attaches label, unit, gate and pass to every measurement. */
export function assembleMetrics(
  measurements: Readonly<Record<MetricId, Measurement>>,
  judge: number | null,
): Record<MetricId, MetricResult> {
  // fromEntries loses the key type; METRIC_IDS is exhaustive by construction.
  return Object.fromEntries(
    METRIC_IDS.map((id) => [id, toResult(id, measurements[id], judge)]),
  ) as Record<MetricId, MetricResult>;
}

/** Hard gates that did not pass. Any entry makes `digest eval` exit with code 1. */
export function failedHardGates(metrics: Readonly<Record<MetricId, MetricResult>>): MetricId[] {
  return METRIC_IDS.filter((id) => metrics[id].gate.kind === 'hard' && metrics[id].pass === false);
}
