import { describe, expect, it } from 'vitest';
import {
  ATTACKS,
  CLEAN,
  DEFAULTS,
  SEPARABLE,
  classified,
  policy,
  rawCapture,
  repeat,
} from '../__fixtures__/records';
import type { ClassifierRecord, InputGuardRecord } from '../capture/schemas';
import { NO_SPLIT } from '../split';
import { TuningResultSchema } from './schema';
import { tuneThresholds } from './tune';

describe('tuneThresholds', () => {
  it('proposes all four thresholds and scores them against the baseline', () => {
    const result = tuneThresholds(rawCapture(), NO_SPLIT);
    expect(result.proposed).toEqual({ ...DEFAULTS, guardFlag: 0.55 });
    expect(result.baseline).toEqual({ ...DEFAULTS, guardFlag: 0.5 });
    expect(result.classifier.filter.proposed).toMatchObject({ accuracy: 1, kept: 2, dropped: 3 });
    expect(result.acceptance.filterAccuracy).toEqual({ value: 1, min: 0.8, pass: true });
    expect(() => TuningResultSchema.parse(result)).not.toThrow();
  });

  it('scores the classifier the way the scorecard does: area and relevance within 0.5', () => {
    const wrongArea: ClassifierRecord = {
      ...classified(3, 2.8, 0.1, 0.1),
      result: { relevance: 2.8, area: 'other', areaConfidence: 0.9, hype: 0.1, minorRelease: 0.1 },
    };
    const result = tuneThresholds(rawCapture({ classifier: [...SEPARABLE, wrongArea] }), NO_SPLIT);
    // 6 cases: two relevance misses (2.5 for a 0, 2.4 for a 1) and one wrong area.
    expect(result.classifier.scorecard.relevance).toBeCloseTo(4 / 6);
    expect(result.classifier.scorecard.area).toBeCloseTo(5 / 6);
    expect(result.acceptance.classifierAccuracy.pass).toBe(false);
  });

  it('checks the proposed filter against the week labels', () => {
    const result = tuneThresholds(rawCapture());
    expect(result.weeks.proposed).toEqual({
      items: 3,
      kept: 1,
      mustInclude: 1,
      mustIncludeKept: 1,
      mustExclude: 1,
      mustExcludeDropped: 1,
    });
  });

  it('fails the false-block acceptance when a guard is over budget at every flag', () => {
    const clean = repeat(10, () => policy('clean', 0.01, true));
    const result = tuneThresholds(rawCapture({ inputGuards: [...clean, ...ATTACKS] }));
    expect(result.acceptance.guardFalseBlocks).toMatchObject({ value: 1, max: 0.05, pass: false });
  });

  it('counts a failed model call anywhere in the capture, also on the held-out side', () => {
    // With stride 3 the third attack is held out, so the train side never sees its failure.
    const [first, second, third, ...rest] = ATTACKS;
    const failed: InputGuardRecord = { ...third!, graniteRisk: { error: 'x' } };
    const result = tuneThresholds(
      rawCapture({ inputGuards: [...CLEAN, first!, second!, failed, ...rest] }),
    );
    expect(result.guards.failed.graniteRisk).toBe(0);
    expect(result.acceptance.failedCalls).toEqual({ count: 1, pass: false });
  });

  it('describes its method, naming the label that keeps an item and the margin', () => {
    const { method } = tuneThresholds(rawCapture());
    expect(Object.keys(method)).toEqual(['keep', 'filter', 'guardFlag', 'ties']);
    expect(method['keep']).toContain('relevance 2 or more');
    expect(method['ties']).toContain('within 2 grid steps');
  });
});

describe('tuneThresholds on a held-out split', () => {
  const weekly = (weekId: string, probability: number): InputGuardRecord => ({
    ...policy('clean', probability),
    from: weekId,
  });
  const weeks = ['2026-W38', '2026-W39', '2026-W40', '2026-W41'];
  const cleanByWeek = (probabilities: Record<string, number>): InputGuardRecord[] =>
    weeks.flatMap((week) => repeat(20, () => weekly(week, probabilities[week] ?? 0.01)));
  const spread = [0, 1, 2, 3, 4, 5].map((i) => classified(i % 4, (i % 4) + 0.2, 0.1, 0.1));

  it('never lets the holdout weeks or cases move the picked thresholds', () => {
    const base = rawCapture({ classifier: spread, inputGuards: [...cleanByWeek({}), ...ATTACKS] });
    const noisy = rawCapture({
      // Held out: the third and sixth case change their label and scores; W40 and W41 turn blocky.
      classifier: spread.map((r, i) => (i % 3 === 2 ? classified(0, 3, 0.9, 0.9) : r)),
      inputGuards: [...cleanByWeek({ '2026-W40': 0.45, '2026-W41': 0.45 }), ...ATTACKS],
    });
    expect(tuneThresholds(noisy).proposed).toEqual(tuneThresholds(base).proposed);
    expect(tuneThresholds(noisy).split?.holdout.weeks).toEqual(['2026-W40', '2026-W41']);
  });

  it('scores both sides and warns when the holdout is much worse', () => {
    const raw = rawCapture({
      classifier: spread.map((r, i) => (i % 3 === 2 ? classified(0, 3, 0.1, 0.1) : r)),
      inputGuards: [...cleanByWeek({}), ...ATTACKS],
    });
    const result = tuneThresholds(raw);
    expect(result.scores?.train.filterAccuracy).toBe(1);
    expect(result.scores?.holdout.filterAccuracy).toBe(0);
    expect(result.scores?.gap.filterAccuracy).toBe(1);
    expect(result.scores?.warnings.length).toBeGreaterThan(0);
    expect(result.split?.train.classifierCases).toBe(4);
    expect(() => TuningResultSchema.parse(result)).not.toThrow();
  });

  it('honours an explicit split and still parses results written before the split existed', () => {
    const raw = rawCapture({ inputGuards: [...cleanByWeek({}), ...ATTACKS] });
    const result = tuneThresholds(raw, { holdoutWeeks: ['2026-W41'], caseStride: 0 });
    expect(result.split?.holdout.weeks).toEqual(['2026-W41']);
    expect(result.split?.holdout.classifierCases).toBe(0);
    const { split: _split, scores: _scores, ...old } = result;
    expect(TuningResultSchema.parse(old)).toEqual(old);
  });
});

describe('tuneThresholds with nothing to measure', () => {
  it('reports null numbers and fails every acceptance check', () => {
    const failed = { error: 'timeout' };
    const result = tuneThresholds(
      rawCapture({
        classifier: [{ ...classified(2, 2, 0, 0), result: failed }],
        weekItems: [{ itemId: 'w1', weekId: '2026-W40', label: null, result: failed }],
        inputGuards: [],
        outputGuards: [],
      }),
    );
    expect(result.classifier.scorecard).toEqual({ value: null, area: null, relevance: null });
    expect(result.weeks.failed).toBe(1);
    expect(result.acceptance.classifierAccuracy.pass).toBe(false);
    expect(result.acceptance.filterAccuracy.pass).toBe(false);
    expect(result.acceptance.guardFalseBlocks).toEqual({ value: null, max: 0.05, pass: false });
  });
});
