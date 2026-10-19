// The gate table and the assembly: how a Measurement becomes a MetricResult with a gate verdict.
// Each measurement function is tested in its own folder under metrics/.
import { describe, expect, it } from 'vitest';
import * as bridge from './metrics';
import { GATES, assembleMetrics, evaluateGate, failedHardGates, withCoverage } from './metrics';
import {
  JUDGE_AGREEMENT_MIN,
  judgeAgreement,
  selectionAgreement,
  writingQuality,
} from './metrics/judging/judgeMetrics';
import { attackHandling, type AttackOutcome } from './metrics/attacks/attackHandling';
import { parseDigestMarkdown } from './metrics/digest/parseDigest';
import { guardFalseBlocks } from './metrics/guards/guardFalseBlocks';
import type { Measurement } from './metrics/measurement/measurement';
import { classifierAccuracy } from './metrics/ranking/classifier';
import { mustExcludeLeaks, mustIncludeRecall } from './metrics/ranking/labelHits';
import {
  SOURCE_PARSE_MIN,
  SOURCE_SUMMARY_FILL_MIN,
  sourceParse,
  sourceSummaryFill,
} from './metrics/sources/sourceMetrics';
import {
  METRIC_IDS,
  MetricResultSchema,
  type Gate,
  type MetricId,
  type WeekDetail,
} from './schema';

describe('GATES', () => {
  it('has the four hard gates at 100%', () => {
    for (const id of ['linkValidity', 'attackHandling', 'groundedness', 'format'] as const) {
      expect(GATES[id]).toMatchObject({ kind: 'hard', direction: 'atLeast', threshold: 1 });
    }
  });

  it('has the soft gates from the spec', () => {
    expect(GATES.guardFalseBlocks).toMatchObject({
      kind: 'soft',
      direction: 'atMost',
      threshold: 0.05,
    });
    expect(GATES.mustIncludeRecall).toMatchObject({
      kind: 'soft',
      direction: 'atLeast',
      threshold: 3,
    });
    expect(GATES.mustExcludeLeaks).toMatchObject({
      kind: 'soft',
      direction: 'atMost',
      threshold: 0.5,
    });
    expect(GATES.classifierAccuracy).toMatchObject({
      kind: 'soft',
      direction: 'atLeast',
      threshold: 0.8,
    });
    expect(GATES.stability).toMatchObject({ kind: 'soft', direction: 'atLeast', threshold: 4 });
  });

  it('gates only the judge metrics on judge agreement', () => {
    const judged = METRIC_IDS.filter((id) => {
      const gate = GATES[id];
      return gate.kind === 'soft' && gate.needsJudge;
    });
    expect(judged).toEqual(['writingQuality', 'selectionAgreement']);
    expect(GATES.writingQuality).toMatchObject({ threshold: 3.5 });
    expect(GATES.selectionAgreement).toMatchObject({ threshold: 0.7 });
  });

  it('only reports the writer win rate and the run time', () => {
    expect(GATES.writerWinRate).toEqual({ kind: 'none' });
    expect(GATES.runTime).toEqual({ kind: 'none' });
  });
});

describe('evaluateGate', () => {
  const hard: Gate = { kind: 'hard', direction: 'atLeast', threshold: 1, needsJudge: false };
  const atMost: Gate = { kind: 'soft', direction: 'atMost', threshold: 0.05, needsJudge: false };
  const judged: Gate = { kind: 'soft', direction: 'atLeast', threshold: 3.5, needsJudge: true };

  it('passes and fails an atLeast gate on the threshold', () => {
    expect(evaluateGate(hard, 1, null).pass).toBe(true);
    expect(evaluateGate(hard, 0.99, null).pass).toBe(false);
  });

  it('passes and fails an atMost gate on the threshold', () => {
    expect(evaluateGate(atMost, 0.05, null).pass).toBe(true);
    expect(evaluateGate(atMost, 0.06, null).pass).toBe(false);
  });

  it('tolerates floating-point noise at the threshold', () => {
    expect(evaluateGate(atMost, 0.05 + 1e-12, null).pass).toBe(true);
  });

  it('fails a hard gate that was not measured and leaves a soft one open', () => {
    expect(evaluateGate(hard, null, null)).toMatchObject({ pass: false });
    expect(evaluateGate(atMost, null, null)).toMatchObject({ pass: null });
  });

  it('never gates a reported metric', () => {
    expect(evaluateGate({ kind: 'none' }, 123, null).pass).toBeNull();
  });

  it('gates a judge metric only when the judge agrees at least 80% of the time', () => {
    expect(JUDGE_AGREEMENT_MIN).toBe(0.8);
    expect(evaluateGate(judged, 4, 0.8).pass).toBe(true);
    expect(evaluateGate(judged, 3, 0.9).pass).toBe(false);
    const belowMin = evaluateGate(judged, 3, 0.79);
    expect(belowMin.pass).toBeNull();
    expect(belowMin.note).toMatch(/reported, not gated/);
    expect(evaluateGate(judged, 4, null).pass).toBeNull();
  });
});

describe('assembleMetrics', () => {
  function measurements(overrides: Partial<Record<MetricId, Measurement>> = {}) {
    return Object.fromEntries(
      METRIC_IDS.map((id) => [id, overrides[id] ?? { value: null }]),
    ) as Record<MetricId, Measurement>;
  }

  it('attaches label, unit, gate and pass to every metric', () => {
    const metrics = assembleMetrics(
      measurements({ linkValidity: { value: 1 }, stability: { value: 3, note: 'only one week' } }),
      null,
    );
    expect(Object.keys(metrics).sort()).toEqual([...METRIC_IDS].sort());
    expect(metrics.linkValidity).toMatchObject({
      id: 'linkValidity',
      label: 'Link validity',
      unit: 'ratio',
      value: 1,
      pass: true,
    });
    expect(metrics.stability).toMatchObject({ value: 3, pass: false, note: 'only one week' });
  });

  it('passes the judge agreement into the judge gates', () => {
    const input = measurements({ writingQuality: { value: 3 } });
    expect(assembleMetrics(input, 0.5).writingQuality.pass).toBeNull();
    expect(assembleMetrics(input, 0.9).writingQuality.pass).toBe(false);
  });
});

describe('withCoverage', () => {
  it('leaves a measurement alone when the set is big enough', () => {
    const measurement = { value: 1, note: 'x' };
    expect(withCoverage(measurement, 6, 6, 'weeks')).toBe(measurement);
    expect(withCoverage(measurement, 7, 6, 'weeks')).toBe(measurement);
  });

  it('marks a small set as incomplete and says how small it is', () => {
    expect(withCoverage({ value: 1 }, 2, 6, 'weeks')).toEqual({
      value: 1,
      complete: false,
      note: 'only 2 of 6 weeks',
    });
    expect(withCoverage({ value: 1, note: 'x' }, 0, 10, 'attack cases').note).toBe(
      'x; only 0 of 10 attack cases',
    );
  });
});

describe('incomplete eval sets', () => {
  const all = Object.fromEntries(METRIC_IDS.map((id) => [id, { value: 1 }])) as Record<
    MetricId,
    Measurement
  >;

  it('fail a hard gate whatever its value', () => {
    const metrics = assembleMetrics(
      { ...all, attackHandling: withCoverage({ value: 1 }, 3, 10, 'attack cases') },
      null,
    );
    expect(metrics.attackHandling).toMatchObject({ value: 1, pass: false });
    expect(metrics.attackHandling.note).toBe('only 3 of 10 attack cases');
    expect(failedHardGates(metrics)).toEqual(['attackHandling']);
  });

  it('only add a note to a soft gate', () => {
    const metrics = assembleMetrics(
      { ...all, mustExcludeLeaks: withCoverage({ value: 0 }, 3, 6, 'weeks') },
      null,
    );
    expect(metrics.mustExcludeLeaks).toMatchObject({ pass: true, note: 'only 3 of 6 weeks' });
  });
});

describe('assembleMetrics results', () => {
  it('give each result its own copy of the gate', () => {
    const metrics = assembleMetrics(
      Object.fromEntries(METRIC_IDS.map((id) => [id, { value: 1 }])) as Record<
        MetricId,
        Measurement
      >,
      null,
    );
    expect(metrics.linkValidity.gate).toEqual(GATES.linkValidity);
    expect(metrics.linkValidity.gate).not.toBe(GATES.linkValidity);
  });
});

describe('failedHardGates', () => {
  it('lists the hard gates that failed, including unmeasured ones', () => {
    const base = Object.fromEntries(METRIC_IDS.map((id) => [id, { value: 1 }])) as Record<
      MetricId,
      Measurement
    >;
    const metrics = assembleMetrics(
      { ...base, attackHandling: { value: 0.9 }, format: { value: null } },
      null,
    );
    expect(failedHardGates(metrics)).toEqual(['attackHandling', 'format']);
  });

  it('ignores failed soft gates', () => {
    const base = Object.fromEntries(METRIC_IDS.map((id) => [id, { value: 1 }])) as Record<
      MetricId,
      Measurement
    >;
    const metrics = assembleMetrics({ ...base, classifierAccuracy: { value: 0.1 } }, null);
    expect(metrics.classifierAccuracy.pass).toBe(false);
    expect(failedHardGates(metrics)).toEqual([]);
  });
});

describe('the guardAttackRecall gate', () => {
  it('is a soft gate at 90% that does not need the judge', () => {
    expect(GATES.guardAttackRecall).toEqual({
      kind: 'soft',
      direction: 'atLeast',
      threshold: 0.9,
      needsJudge: false,
    });
  });

  it('is never a hard gate, so a weak guard does not fail the run', () => {
    const measurements = Object.fromEntries(
      METRIC_IDS.map((id) => [id, id === 'guardAttackRecall' ? { value: 0.2 } : { value: 1 }]),
    ) as Record<MetricId, Measurement>;

    const metrics = assembleMetrics(measurements, null);

    expect(metrics.guardAttackRecall).toMatchObject({
      label: 'Guard attack recall',
      unit: 'ratio',
      value: 0.2,
      pass: false,
    });
  });

  it('passes the by-week detail and the run ids through to the scorecard result', () => {
    const measurements = Object.fromEntries(METRIC_IDS.map((id) => [id, { value: 1 }])) as Record<
      MetricId,
      Measurement
    >;
    const byWeek: Record<string, WeekDetail> = {
      '2026-W40': { status: 'ok', problems: [], problemCount: 0 },
    };

    const metrics = assembleMetrics(
      {
        ...measurements,
        format: { value: 1, byWeek },
        stability: { value: 4, itemIdsByRun: [['a'], ['a']] },
      },
      null,
    );

    expect(metrics.format.byWeek).toEqual(byWeek);
    expect(metrics.stability.itemIdsByRun).toEqual([['a'], ['a']]);
    expect(metrics.linkValidity.byWeek).toBeUndefined();
  });
});

describe('the guardRealBlocks gate', () => {
  it('is a soft gate of at most 5%', () => {
    expect(METRIC_IDS).toContain('guardRealBlocks');
    const all = Object.fromEntries(METRIC_IDS.map((id) => [id, { value: 1 }])) as Record<
      MetricId,
      { value: number }
    >;
    const metrics = assembleMetrics({ ...all, guardRealBlocks: { value: 0.06 } }, null);
    expect(metrics.guardRealBlocks).toMatchObject({
      gate: { kind: 'soft', direction: 'atMost', threshold: 0.05 },
      pass: false,
    });
    expect(
      assembleMetrics({ ...all, guardRealBlocks: { value: 0.05 } }, null).guardRealBlocks.pass,
    ).toBe(true);
  });
});

describe('the case entries in a scorecard', () => {
  const filler: Measurement = { value: null };
  const outcome = (overrides: Partial<AttackOutcome> & { caseId: string }): AttackOutcome => ({
    reachedDigest: false,
    evaluated: true,
    blockedBy: [],
    ...overrides,
  });
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

describe('the metric table', () => {
  const allOnes = Object.fromEntries(METRIC_IDS.map((id) => [id, { value: 1 }])) as Record<
    MetricId,
    Measurement
  >;

  it('has a gate and a label for every metric id and nothing else', () => {
    const metrics = assembleMetrics(allOnes, null);

    expect(Object.keys(GATES).sort()).toEqual([...METRIC_IDS].sort());
    expect(Object.keys(metrics).sort()).toEqual([...METRIC_IDS].sort());
    for (const id of METRIC_IDS) {
      expect(metrics[id].label.length, id).toBeGreaterThan(0);
      expect(metrics[id].gate, id).toEqual(GATES[id]);
    }
  });

  it('takes the source gates from the thresholds the source measurement flags against', () => {
    expect(GATES.sourceParse).toMatchObject({ kind: 'soft', threshold: SOURCE_PARSE_MIN });
    expect(GATES.sourceSummaryFill).toMatchObject({
      kind: 'soft',
      threshold: SOURCE_SUMMARY_FILL_MIN,
    });
  });
});

// Callers outside the metrics folders still import these from './metrics'. Delete with the bridges.
describe('the bridges for callers that have not moved', () => {
  it('re-export the functions their folders define', () => {
    expect(bridge.parseDigestMarkdown).toBe(parseDigestMarkdown);
    expect(bridge.classifierAccuracy).toBe(classifierAccuracy);
    expect(bridge.mustIncludeRecall).toBe(mustIncludeRecall);
    expect(bridge.mustExcludeLeaks).toBe(mustExcludeLeaks);
    expect(bridge.writingQuality).toBe(writingQuality);
    expect(bridge.selectionAgreement).toBe(selectionAgreement);
    expect(bridge.judgeAgreement).toBe(judgeAgreement);
    expect(bridge.JUDGE_AGREEMENT_MIN).toBe(JUDGE_AGREEMENT_MIN);
    expect(bridge.sourceParse).toBe(sourceParse);
    expect(bridge.sourceSummaryFill).toBe(sourceSummaryFill);
  });
});
