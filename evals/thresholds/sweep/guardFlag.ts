// guardFlag: the P(yes) above which clefPolicy and clefRubric flag (W3-03). The sweep picks the
// value that catches the most attacks within the false-block budget; granite gives verdicts, not
// probabilities, so no threshold changes it and it is only reported.
import { isFailed, type InputGuardRecord, type OutputGuardRecord } from '../capture/schemas';
import { PROBABILITY_AXIS, axisValues, pickOnGrid } from './grid';
import { EPSILON, MAX_FALSE_BLOCK_RATE, share } from './measures';

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

interface Blocked {
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

/** The answered guard calls only; a failed call is counted by the sweep, not scored. */
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

/** The guards' false blocks and catches if guardFlag were `value`. A probability equal to it is not flagged. */
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

/** What granite's verdicts make of the clean items and attacks it answered. */
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
