// Train and holdout split of a raw capture (W6-04, F56): thresholds are picked on the train
// side only and scored on both, so the holdout number was not used to choose anything.
import type { Thresholds } from '../../src/config/schema';
import { WeekIdSchema } from '../../src/domain/schemas';
import { DigestError } from '../../src/shared/errors';
import { classifierAccuracy } from '../metrics';
import { isFailed, type ClassifierRecord, type RawCapture } from './capture/schemas';
import { filterOutcome, filterSamples } from './sweep/filter';
import { graniteResult, guardFlagPoint, guardSamples } from './sweep/guardFlag';
import { EPSILON } from './sweep/measures';

/** The holdout keeps every CASE_STRIDE-th classifier case, attack and grounding case (the 3rd, 6th, ...). */
export const CASE_STRIDE = 3;
/** The default holdout is the newest recorded weeks, as many as this (fewer if one must stay to train on). */
export const DEFAULT_HOLDOUT_WEEKS = 2;
/** A train-to-holdout gap above this prints a warning. */
export const GAP_WARNING = 0.1;

export interface Split {
  /** Weeks whose items are never used to pick. */
  holdoutWeeks: readonly string[];
  /** Every n-th classifier case, attack and grounding case is held out; 0 holds none out. */
  caseStride: number;
}

/** Everything on the train side: the sweep sees the whole capture. */
export const NO_SPLIT: Split = { holdoutWeeks: [], caseStride: 0 };

export function recordedWeeks(raw: RawCapture): string[] {
  const weeks = new Set([
    ...raw.weekItems.map((r) => r.weekId),
    ...raw.inputGuards.filter((g) => g.kind === 'clean').map((g) => g.from),
  ]);
  return [...weeks].sort();
}

/** The two newest recorded weeks (at least one week stays to train on) and every third case. */
export function defaultSplit(raw: RawCapture): Split {
  const weeks = recordedWeeks(raw);
  const count = Math.min(DEFAULT_HOLDOUT_WEEKS, Math.max(0, weeks.length - 1));
  return { holdoutWeeks: weeks.slice(weeks.length - count), caseStride: CASE_STRIDE };
}

/** `--holdout 2026-W40,2026-W41`: week ids, sorted. */
export function parseHoldoutWeeks(text: string): string[] {
  const weeks = text
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (weeks.length === 0) throw new DigestError('--holdout needs week ids, e.g. 2026-W40,2026-W41');
  for (const week of weeks) {
    if (!WeekIdSchema.safeParse(week).success)
      throw new DigestError(`--holdout: "${week}" is not a week id like 2026-W40`);
  }
  return [...new Set(weeks)].sort();
}

const isHeldOut = (index: number, stride: number): boolean =>
  stride > 0 && index % stride === stride - 1;

/** Positions of the distinct `keys`, in order of first appearance, that the holdout takes. */
function heldOutKeys(keys: readonly string[], stride: number): Set<string> {
  return new Set([...new Set(keys)].filter((_, index) => isHeldOut(index, stride)));
}

function assertWeeks(raw: RawCapture, split: Split): void {
  const known = recordedWeeks(raw);
  const missing = split.holdoutWeeks.filter((week) => !known.includes(week));
  if (missing.length > 0)
    throw new DigestError(
      `--holdout: the capture has no week ${missing.join(', ')} (it has ${known.join(', ')})`,
    );
  if (known.length > 0 && known.every((week) => split.holdoutWeeks.includes(week)))
    throw new DigestError('--holdout leaves no week to pick on; keep at least one week for train');
}

function partition<T>(items: readonly T[], isHoldout: (item: T, index: number) => boolean) {
  return {
    train: items.filter((item, index) => !isHoldout(item, index)),
    holdout: items.filter((item, index) => isHoldout(item, index)),
  };
}

/** Splits a capture in two disjoint captures that together hold every record. */
export function splitCapture(
  raw: RawCapture,
  split: Split,
): { train: RawCapture; holdout: RawCapture } {
  assertWeeks(raw, split);
  const { caseStride: stride } = split;
  const inHoldoutWeek = (week: string): boolean => split.holdoutWeeks.includes(week);
  const attacks = heldOutKeys(
    raw.inputGuards.filter((g) => g.kind === 'attack').map((g) => g.itemId),
    stride,
  );
  const drafts = heldOutKeys(
    raw.outputGuards.map((o) => o.caseId),
    stride,
  );
  const classifier = partition<ClassifierRecord>(raw.classifier, (_, i) => isHeldOut(i, stride));
  const weekItems = partition(raw.weekItems, (r) => inHoldoutWeek(r.weekId));
  const inputGuards = partition(raw.inputGuards, (g) =>
    g.kind === 'clean' ? inHoldoutWeek(g.from) : attacks.has(g.itemId),
  );
  const outputGuards = partition(raw.outputGuards, (o) => drafts.has(o.caseId));
  return {
    train: {
      ...raw,
      classifier: classifier.train,
      weekItems: weekItems.train,
      inputGuards: inputGuards.train,
      outputGuards: outputGuards.train,
    },
    holdout: {
      ...raw,
      classifier: classifier.holdout,
      weekItems: weekItems.holdout,
      inputGuards: inputGuards.holdout,
      outputGuards: outputGuards.holdout,
    },
  };
}

// --- Scores ---------------------------------------------------------------------------------

export interface SideScore {
  /** The scorecard's measure: area right and relevance within 0.5. */
  classifierAccuracy: number | null;
  /** Keep or drop as labelled, at the thresholds. */
  filterAccuracy: number | null;
  /** The worst of clefPolicy, clefRubric and granite on clean items and drafts. */
  falseBlocks: number | null;
  /** Share of attack cases clefPolicy flags. */
  attackRecall: number | null;
}

/** The scorecard's classifier accuracy over the answered cases. */
export function scorecardAccuracy(records: readonly ClassifierRecord[]): {
  value: number | null;
  area: number | null;
  relevance: number | null;
} {
  const results = records.flatMap(({ expected, result }) =>
    isFailed(result)
      ? []
      : [{ expected, actual: { area: result.area, relevance: result.relevance } }],
  );
  const { value, detail } = classifierAccuracy(results);
  return { value, area: detail?.area ?? null, relevance: detail?.relevance ?? null };
}

export function worst(rates: readonly (number | null)[]): number | null {
  const known = rates.filter((rate): rate is number => rate !== null);
  return known.length === 0 ? null : Math.max(...known);
}

/** How one side of the split does at the given thresholds. */
export function scoreSide(side: RawCapture, thresholds: Thresholds): SideScore {
  const guards = guardSamples(side.inputGuards, side.outputGuards);
  const point = guardFlagPoint(guards, thresholds.guardFlag);
  const attacks = guards.policy.filter((s) => s.record.kind === 'attack').length;
  return {
    classifierAccuracy: scorecardAccuracy(side.classifier).value,
    filterAccuracy: filterOutcome(filterSamples(side.classifier), thresholds).accuracy,
    falseBlocks: worst([
      point.policyFalseBlockRate,
      point.rubricFalseBlockRate,
      graniteResult(side.inputGuards).falseBlockRate,
    ]),
    attackRecall: attacks === 0 ? null : point.attacksCaught / attacks,
  };
}

export interface Comparison {
  /** Train minus holdout for the accuracies, holdout minus train for false blocks. */
  gap: {
    classifierAccuracy: number | null;
    filterAccuracy: number | null;
    falseBlocks: number | null;
  };
  warnings: string[];
}

const GAP_DECIMALS = 1e4;
const difference = (a: number | null, b: number | null): number | null =>
  a === null || b === null ? null : Math.round((a - b) * GAP_DECIMALS) / GAP_DECIMALS;
/** A rate to three decimals; "n/a" when it could not be measured. */
export const fixed = (value: number | null): string => (value === null ? 'n/a' : value.toFixed(3));

export function compareSides(train: SideScore, holdout: SideScore): Comparison {
  const gap = {
    classifierAccuracy: difference(train.classifierAccuracy, holdout.classifierAccuracy),
    filterAccuracy: difference(train.filterAccuracy, holdout.filterAccuracy),
    falseBlocks: difference(holdout.falseBlocks, train.falseBlocks),
  };
  const over = (value: number | null): value is number =>
    value !== null && value > GAP_WARNING + EPSILON;
  const warn = (what: string, verb: string, value: number | null): string[] =>
    over(value)
      ? [`WARNING: ${what} ${verb} ${fixed(value)} from train to holdout (limit ${GAP_WARNING})`]
      : [];
  return {
    gap,
    warnings: [
      ...warn('filter accuracy', 'falls', gap.filterAccuracy),
      ...warn('classifier accuracy', 'falls', gap.classifierAccuracy),
      ...warn('false blocks', 'rise', gap.falseBlocks),
    ],
  };
}

/** Train and holdout side by side with the gap, then any warnings. */
export function splitLines(train: SideScore, holdout: SideScore, comparison: Comparison): string[] {
  const row = (label: string, a: number | null, b: number | null, gap: number | null): string =>
    `  ${label.padEnd(20)} ${fixed(a).padEnd(8)} ${fixed(b).padEnd(8)} ${fixed(gap)}`;
  return [
    `  ${''.padEnd(20)} ${'train'.padEnd(8)} ${'holdout'.padEnd(8)} gap`,
    row(
      'classifier accuracy',
      train.classifierAccuracy,
      holdout.classifierAccuracy,
      comparison.gap.classifierAccuracy,
    ),
    row(
      'filter accuracy',
      train.filterAccuracy,
      holdout.filterAccuracy,
      comparison.gap.filterAccuracy,
    ),
    row('false blocks', train.falseBlocks, holdout.falseBlocks, comparison.gap.falseBlocks),
    row('attacks caught', train.attackRecall, holdout.attackRecall, null),
    ...comparison.warnings,
  ];
}

export interface SideSize {
  weeks: string[];
  classifierCases: number;
  cleanItems: number;
  attacks: number;
  /** Grounding drafts (planted and control) clefRubric saw. */
  drafts: number;
}

/** What is on one side of the split. */
export function sideSize(side: RawCapture): SideSize {
  return {
    weeks: recordedWeeks(side),
    classifierCases: side.classifier.length,
    cleanItems: side.inputGuards.filter((g) => g.kind === 'clean').length,
    attacks: side.inputGuards.filter((g) => g.kind === 'attack').length,
    drafts: side.outputGuards.length,
  };
}
