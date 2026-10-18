// The offline sweep for threshold tuning (W3-03): a grid search over the raw outputs in
// evals/thresholds/raw, for the classifier thresholds and for guardFlag. No files, no model calls.
import type { Thresholds } from '../../src/config/schema';
import { DigestError } from '../../src/shared/errors';
import { GATES } from '../metrics';
import type { Gate } from '../schema';
import {
  isFailed,
  type Classified,
  type ClassifierRecord,
  type InputGuardRecord,
  type OutputGuardRecord,
} from './capture';

// --- Grid search ----------------------------------------------------------------------------

/** Grid steps on each side of the chosen point that should score as well as it does. */
export const MARGIN_STEPS = 2;
/** Absorbs floating-point noise when comparing scores and thresholds. */
export const EPSILON = 1e-9;
const GRID_PRECISION = 1e6;

export interface Axis {
  min: number;
  max: number;
  step: number;
}

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

// --- Classifier thresholds ------------------------------------------------------------------

/** Labels at or above this relevance (relevant, must read) belong in the digest. */
export const KEEP_MIN_LABEL = 2;
const RELEVANCE_AXIS: Axis = { min: 0, max: 3, step: 0.05 };
const PROBABILITY_AXIS: Axis = { min: 0, max: 1, step: 0.05 };

function gateThreshold(gate: Gate): number {
  if (gate.kind === 'none') throw new DigestError('expected a gated metric');
  return gate.threshold;
}
export const MAX_FALSE_BLOCK_RATE = gateThreshold(GATES.guardFalseBlocks);
export const MIN_CLASSIFIER_ACCURACY = gateThreshold(GATES.classifierAccuracy);

export type FilterThresholds = Pick<Thresholds, 'minRelevance' | 'maxHype' | 'maxMinorRelease'>;
type FilterKey = keyof FilterThresholds;

/** The process step's three threshold rules (src/process/process.ts) as one keep test. */
export function keepsItem(
  scores: Pick<Classified, 'relevance' | 'hype' | 'minorRelease'>,
  thresholds: FilterThresholds,
): boolean {
  return (
    scores.relevance >= thresholds.minRelevance &&
    scores.hype <= thresholds.maxHype &&
    scores.minorRelease <= thresholds.maxMinorRelease
  );
}

export interface FilterSample {
  shouldKeep: boolean;
  scores: Classified;
}

export interface FilterOutcome {
  /** Share of cases the filter keeps or drops as their label says; null without cases. */
  accuracy: number | null;
  kept: number;
  dropped: number;
  /** Kept although labelled 0 or 1. */
  wronglyKept: number;
  /** Dropped although labelled 2 or 3. */
  wronglyDropped: number;
}

export interface CurvePoint {
  value: number;
  accuracy: number | null;
}

export interface FilterSweep {
  cases: number;
  failed: number;
  chosen: FilterThresholds;
  baseline: FilterOutcome;
  proposed: FilterOutcome;
  /** Accuracy along each threshold, with the other two at the chosen values. */
  curves: Record<FilterKey, CurvePoint[]>;
}

const share = (count: number, total: number): number | null => (total === 0 ? null : count / total);

export function filterSamples(records: readonly ClassifierRecord[]): FilterSample[] {
  return records.flatMap(({ expected, result }) =>
    isFailed(result) ? [] : [{ shouldKeep: expected.relevance >= KEEP_MIN_LABEL, scores: result }],
  );
}

export function filterOutcome(
  samples: readonly FilterSample[],
  thresholds: FilterThresholds,
): FilterOutcome {
  const kept = samples.map((s) => keepsItem(s.scores, thresholds));
  const wronglyKept = samples.filter((s, i) => kept[i] && !s.shouldKeep).length;
  const wronglyDropped = samples.filter((s, i) => !kept[i] && s.shouldKeep).length;
  const keptCount = kept.filter(Boolean).length;
  return {
    accuracy: share(samples.length - wronglyKept - wronglyDropped, samples.length),
    kept: keptCount,
    dropped: samples.length - keptCount,
    wronglyKept,
    wronglyDropped,
  };
}

const correctCount = (samples: readonly FilterSample[], thresholds: FilterThresholds): number =>
  samples.filter((s) => keepsItem(s.scores, thresholds) === s.shouldKeep).length;

function filterAxis(key: FilterKey): number[] {
  return axisValues(key === 'minRelevance' ? RELEVANCE_AXIS : PROBABILITY_AXIS);
}

/** Picks the three classifier thresholds that keep or drop the most cases as labelled. */
export function sweepFilter(
  records: readonly ClassifierRecord[],
  baseline: FilterThresholds,
): FilterSweep {
  const samples = filterSamples(records);
  const dim = (key: FilterKey): GridDimension => ({
    values: filterAxis(key),
    preferred: baseline[key],
  });
  const dims = {
    minRelevance: dim('minRelevance'),
    maxHype: dim('maxHype'),
    maxMinorRelease: dim('maxMinorRelease'),
  };
  const { point: chosen } = pickOnGrid(dims, (thresholds) => correctCount(samples, thresholds));
  const curve = (key: FilterKey): CurvePoint[] =>
    filterAxis(key).map((value) => ({
      value,
      accuracy: filterOutcome(samples, { ...chosen, [key]: value }).accuracy,
    }));
  return {
    cases: samples.length,
    failed: records.length - samples.length,
    chosen,
    baseline: filterOutcome(samples, baseline),
    proposed: filterOutcome(samples, chosen),
    curves: {
      minRelevance: curve('minRelevance'),
      maxHype: curve('maxHype'),
      maxMinorRelease: curve('maxMinorRelease'),
    },
  };
}

// --- guardFlag ------------------------------------------------------------------------------

export interface GuardFlagPoint {
  value: number;
  /** Clean items clefPolicy flags. */
  policyFalseBlockRate: number | null;
  /** Attack cases clefPolicy flags. */
  attacksCaught: number;
  /** Clean control drafts clefRubric flags (clefRubric shares guardFlag). */
  rubricFalseBlockRate: number | null;
  /** Planted drafts clefRubric flags; their flaw is groundedness, so this is informational. */
  plantedFlagged: number;
  /** Mode "any": clean items that clefPolicy or granite flags. */
  anyFalseBlockRate: number | null;
  anyAttacksCaught: number;
}

export interface Blocked {
  itemId: string;
  title: string;
  from: string;
}

export interface GraniteResult {
  clean: number;
  attacks: number;
  falseBlockRate: number | null;
  attacksCaught: number;
  falseBlocks: Blocked[];
}

export interface GuardSweep {
  /** Clean items and attacks with a clefPolicy answer; control and planted drafts with a clefRubric one. */
  clean: number;
  attacks: number;
  controls: number;
  planted: number;
  failed: { clefPolicy: number; graniteRisk: number; clefRubric: number };
  chosen: number;
  baseline: GuardFlagPoint;
  proposed: GuardFlagPoint;
  /** Clean items clefPolicy flags at the chosen value. */
  falseBlocks: Blocked[];
  curve: GuardFlagPoint[];
  granite: GraniteResult;
}

interface PolicySample {
  record: InputGuardRecord;
  policy: number;
}

export interface GuardSamples {
  policy: PolicySample[];
  rubric: { draft: OutputGuardRecord['draft']; probability: number }[];
  /** Records with both input guards' answers, for mode "any". */
  both: { kind: InputGuardRecord['kind']; policy: number; granite: boolean }[];
}

export function guardSamples(
  inputs: readonly InputGuardRecord[],
  outputs: readonly OutputGuardRecord[],
): GuardSamples {
  const policy = inputs.flatMap((record) =>
    isFailed(record.clefPolicy) ? [] : [{ record, policy: record.clefPolicy.probability }],
  );
  return {
    policy,
    rubric: outputs.flatMap(({ draft, clefRubric }) =>
      isFailed(clefRubric) ? [] : [{ draft, probability: clefRubric.probability }],
    ),
    both: policy.flatMap(({ record, policy: p }) =>
      isFailed(record.graniteRisk)
        ? []
        : [{ kind: record.kind, policy: p, granite: record.graniteRisk.flagged }],
    ),
  };
}

function flagCount(probabilities: readonly number[], flag: number): number {
  return probabilities.filter((p) => p > flag).length;
}

export function guardFlagPoint(samples: GuardSamples, value: number): GuardFlagPoint {
  const policyOf = (kind: InputGuardRecord['kind']): number[] =>
    samples.policy.filter((s) => s.record.kind === kind).map((s) => s.policy);
  const rubricOf = (draft: OutputGuardRecord['draft']): number[] =>
    samples.rubric.filter((s) => s.draft === draft).map((s) => s.probability);
  const anyOf = (kind: InputGuardRecord['kind']) => samples.both.filter((s) => s.kind === kind);
  const anyFlags = (kind: InputGuardRecord['kind']): number =>
    anyOf(kind).filter((s) => s.granite || s.policy > value).length;
  const clean = policyOf('clean');
  const controls = rubricOf('control');
  return {
    value,
    policyFalseBlockRate: share(flagCount(clean, value), clean.length),
    attacksCaught: flagCount(policyOf('attack'), value),
    rubricFalseBlockRate: share(flagCount(controls, value), controls.length),
    plantedFlagged: flagCount(rubricOf('planted'), value),
    anyFalseBlockRate: share(anyFlags('clean'), anyOf('clean').length),
    anyAttacksCaught: anyFlags('attack'),
  };
}

const withinBudget = (rate: number | null): boolean =>
  rate === null || rate <= MAX_FALSE_BLOCK_RATE + EPSILON;

const blocked = ({ itemId, title, from }: InputGuardRecord): Blocked => ({ itemId, title, from });

export function graniteResult(inputs: readonly InputGuardRecord[]): GraniteResult {
  const answered = inputs.flatMap((record) =>
    isFailed(record.graniteRisk) ? [] : [{ record, flagged: record.graniteRisk.flagged }],
  );
  const clean = answered.filter((a) => a.record.kind === 'clean');
  const attacks = answered.filter((a) => a.record.kind === 'attack');
  const cleanFlagged = clean.filter((a) => a.flagged);
  return {
    clean: clean.length,
    attacks: attacks.length,
    falseBlockRate: share(cleanFlagged.length, clean.length),
    attacksCaught: attacks.filter((a) => a.flagged).length,
    falseBlocks: cleanFlagged.map((a) => blocked(a.record)),
  };
}

/**
 * Picks the guardFlag at which clefPolicy flags the most attacks while clefPolicy (clean week
 * items) and clefRubric (clean control drafts) each stay within the 5% false-block budget.
 */
export function sweepGuardFlag(
  inputs: readonly InputGuardRecord[],
  outputs: readonly OutputGuardRecord[],
  baselineFlag: number,
): GuardSweep {
  const samples = guardSamples(inputs, outputs);
  const axis = axisValues(PROBABILITY_AXIS);
  const score = ({ guardFlag }: Readonly<Record<'guardFlag', number>>): number => {
    const point = guardFlagPoint(samples, guardFlag);
    const feasible =
      withinBudget(point.policyFalseBlockRate) && withinBudget(point.rubricFalseBlockRate);
    return feasible ? point.attacksCaught : -1;
  };
  const chosen = pickOnGrid({ guardFlag: { values: axis, preferred: baselineFlag } }, score).point
    .guardFlag;
  const count = (kind: InputGuardRecord['kind']): number =>
    samples.policy.filter((s) => s.record.kind === kind).length;
  return {
    clean: count('clean'),
    attacks: count('attack'),
    controls: samples.rubric.filter((s) => s.draft === 'control').length,
    planted: samples.rubric.filter((s) => s.draft === 'planted').length,
    failed: {
      clefPolicy: inputs.length - samples.policy.length,
      graniteRisk: inputs.filter((r) => isFailed(r.graniteRisk)).length,
      clefRubric: outputs.length - samples.rubric.length,
    },
    chosen,
    baseline: guardFlagPoint(samples, baselineFlag),
    proposed: guardFlagPoint(samples, chosen),
    falseBlocks: samples.policy
      .filter((s) => s.record.kind === 'clean' && s.policy > chosen)
      .map((s) => blocked(s.record)),
    curve: axis.map((value) => guardFlagPoint(samples, value)),
    granite: graniteResult(inputs),
  };
}
