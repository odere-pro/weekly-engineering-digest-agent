// The scorecard names the cases behind the two numbers that moved in the wave 5 re-baseline
// (W5-11): the attack that reached the digest, and the clean controls a guard flagged.
import { describe, expect, it } from 'vitest';
import {
  assembleMetrics,
  attackHandling,
  attackRunMeasurement,
  guardFalseBlocks,
  type AttackOutcome,
  type AttackRunEnd,
  type Measurement,
} from './metrics';
import { METRIC_IDS, MetricResultSchema, type MetricId } from './schema';

const outcome = (overrides: Partial<AttackOutcome> & { caseId: string }): AttackOutcome => ({
  reachedDigest: false,
  evaluated: true,
  blockedBy: [],
  ...overrides,
});

describe('attackHandling names the cases (W5-11)', () => {
  it('names the attack that reached the digest next to the guard counts', () => {
    const result = attackHandling([
      outcome({ caseId: 'attack-01', blockedBy: ['clefPolicy'] }),
      outcome({ caseId: 'attack-04-unlisted-url', reachedDigest: true }),
      outcome({ caseId: 'attack-05', blockedBy: ['clefPolicy', 'graniteRisk'] }),
    ]);

    expect(result.value).toBeCloseTo(2 / 3);
    expect(result.detail).toEqual({
      clefPolicy: 2,
      graniteRisk: 1,
      'reachedDigest:attack-04-unlisted-url': 1,
    });
  });

  it('names an attack item that no guard saw, which proves nothing either way', () => {
    const result = attackHandling([
      outcome({ caseId: 'attack-01', blockedBy: ['clefPolicy'] }),
      outcome({ caseId: 'attack-02', evaluated: false }),
    ]);

    expect(result.detail).toEqual({ clefPolicy: 1, 'unchecked:attack-02': 1 });
  });

  it('names every attack that reached the digest, and one that did both', () => {
    const result = attackHandling([
      outcome({ caseId: 'a1', reachedDigest: true }),
      outcome({ caseId: 'a2', reachedDigest: true, evaluated: false }),
    ]);

    expect(result.value).toBe(0);
    expect(result.detail).toEqual({
      'reachedDigest:a1': 1,
      'reachedDigest:a2': 1,
      'unchecked:a2': 1,
    });
  });

  it('adds nothing when every attack was checked and kept out, as before', () => {
    const result = attackHandling([
      outcome({ caseId: 'a1', blockedBy: ['clefPolicy'] }),
      outcome({ caseId: 'a2' }),
    ]);

    expect(result).toEqual({ value: 1, detail: { clefPolicy: 1 } });
  });

  it('has no detail at all when no guard flagged and nothing went wrong', () => {
    expect(attackHandling([outcome({ caseId: 'a1' })])).toEqual({ value: 1 });
  });

  it('is carried by the scoring of an attack replay', () => {
    const end: AttackRunEnd = {
      status: 'dry-run',
      disabledGuards: [],
      drafts: [],
      baselineStatus: 'dry-run',
    };
    const outcomes = [outcome({ caseId: 'attack-04', reachedDigest: true })];

    expect(attackRunMeasurement(end, outcomes).detail).toEqual({ 'reachedDigest:attack-04': 1 });
  });
});

describe('guardFalseBlocks names the clean controls a guard flagged (W5-11)', () => {
  it('lists the flagged cases per guard next to its rate', () => {
    const result = guardFalseBlocks({
      graniteGroundedness: {
        checked: 4,
        flagged: 2,
        flaggedCases: ['grounding-02-invented-benchmark', 'grounding-05-wrong-maturity'],
      },
      clefRubric: { checked: 4, flagged: 0, flaggedCases: [] },
    });

    expect(result.value).toBe(0.5);
    expect(result.detail).toEqual({
      graniteGroundedness: 0.5,
      clefRubric: 0,
      'flagged:graniteGroundedness:grounding-02-invented-benchmark': 1,
      'flagged:graniteGroundedness:grounding-05-wrong-maturity': 1,
    });
  });

  it('keeps the old detail when the tallies carry no case ids', () => {
    const result = guardFalseBlocks({
      clefPolicy: { checked: 100, flagged: 2 },
      graniteRisk: { checked: 50, flagged: 5 },
    });

    expect(result.detail).toEqual({ clefPolicy: 0.02, graniteRisk: 0.1 });
  });

  it('does not list cases of a guard that checked nothing', () => {
    const result = guardFalseBlocks({
      clefPolicy: { checked: 0, flagged: 0, flaggedCases: ['ghost'] },
      graniteRisk: { checked: 10, flagged: 1, flaggedCases: ['grounding-03'] },
    });

    expect(result.detail).toEqual({ graniteRisk: 0.1, 'flagged:graniteRisk:grounding-03': 1 });
  });
});

describe('the case entries in a scorecard (W5-11)', () => {
  const filler: Measurement = { value: null };
  const measurements = Object.fromEntries(METRIC_IDS.map((id) => [id, filler])) as Record<
    MetricId,
    Measurement
  >;

  it('pass through to the metric result and parse back, so old and new scorecards both read', () => {
    const metrics = assembleMetrics(
      {
        ...measurements,
        attackHandling: attackHandling([outcome({ caseId: 'attack-04', reachedDigest: true })]),
        guardFalseBlocks: guardFalseBlocks({
          graniteGroundedness: { checked: 1, flagged: 1, flaggedCases: ['grounding-02'] },
        }),
      },
      null,
    );

    expect(metrics.attackHandling.detail).toEqual({ 'reachedDigest:attack-04': 1 });
    expect(metrics.guardFalseBlocks.detail).toEqual({
      graniteGroundedness: 1,
      'flagged:graniteGroundedness:grounding-02': 1,
    });
    for (const id of ['attackHandling', 'guardFalseBlocks'] as const) {
      expect(MetricResultSchema.parse(JSON.parse(JSON.stringify(metrics[id])))).toEqual(
        metrics[id],
      );
    }
  });
});
