import { describe, expect, it } from 'vitest';
import { PROFILES } from '../../src/config/profiles';
import { renderDigest } from '../../src/render/markdown';
import { makeDigest, makeDigestItem, makeItem, makeRunRecord } from '../../test/builders';
import { makeApp } from '../evalKit';
import { attackHandling } from '../metrics/attacks/attackHandling';
import { makeReplay } from '../replay/__fixtures__/replayKit';
import { METRIC_IDS, type JudgeCalibration } from '../schema';
import {
  attackMeasurement,
  calibrationFor,
  groundingMeasurement,
  measure,
  winnerScore,
} from './measure';
import {
  emptyCases,
  emptyRun,
  makeScoring,
  makeWeek,
  makeWeekRun,
} from './__fixtures__/scoringKit';

const CALIBRATION: JudgeCalibration = { judgeAgreement: 0.9, selectionAgreement: 0.8 };

describe('calibrationFor', () => {
  it('is the calibration of the cases for a profile that has a judge', () => {
    const scoring = makeScoring({ cases: { ...emptyCases(), calibration: CALIBRATION } });

    expect(calibrationFor(scoring)).toEqual(CALIBRATION);
  });

  it('is null for a profile without a judge, whatever the cases hold', () => {
    const scoring = makeScoring({
      app: makeApp({}, PROFILES.fast).deps,
      cases: { ...emptyCases(), calibration: CALIBRATION },
    });

    expect(calibrationFor(scoring)).toBeNull();
  });
});

describe('winnerScore', () => {
  const draft = (writer: string, score?: number) => ({
    writer,
    passed: true,
    rejectedBy: [],
    ...(score === undefined ? {} : { score: { writer, score, byCriterion: {} } }),
  });

  it('is the judge score of the draft that won', () => {
    const record = makeRunRecord({
      winner: 'qwen',
      drafts: [draft('gemma', 2), draft('qwen', 4.5)],
    });

    expect(winnerScore(record)).toBe(4.5);
  });

  it('is undefined without a winner, or when the winner has no score', () => {
    expect(
      winnerScore(makeRunRecord({ winner: null, drafts: [draft('gemma', 2)] })),
    ).toBeUndefined();
    expect(
      winnerScore(makeRunRecord({ winner: 'gemma', drafts: [draft('gemma')] })),
    ).toBeUndefined();
  });
});

describe('attackMeasurement', () => {
  it('is the empty attack measurement when no attack replay ran', () => {
    expect(attackMeasurement(undefined, undefined)).toEqual(attackHandling([]));
  });

  it('is not measured when the attack replay did not finish as a dry run', () => {
    const run = makeReplay({ record: makeRunRecord({ status: 'failed' }) });

    const result = attackMeasurement({ run, outcomes: [] }, undefined);

    expect(result.value).toBeNull();
    expect(result.note).toContain('ended as "failed"');
  });
});

describe('groundingMeasurement', () => {
  it('is not measured, and says which checks were off, when an output guard did not run', () => {
    const grounding = { outcomes: [], tallies: {}, disabledChecks: ['clefRubric' as const] };

    expect(groundingMeasurement(grounding)).toEqual({
      value: null,
      note: 'guards were off: clefRubric',
    });
  });

  it('is the share of planted claims caught', () => {
    const grounding = {
      outcomes: [
        { caseId: 'g1', caught: true, flaggedBy: ['graniteGroundedness' as const] },
        { caseId: 'g2', caught: false, flaggedBy: [] },
      ],
      tallies: {},
      disabledChecks: [],
    };

    expect(groundingMeasurement(grounding).value).toBe(0.5);
  });
});

describe('measure', () => {
  it('has one measurement for every metric id', () => {
    const measurements = measure(makeScoring());

    expect(Object.keys(measurements).sort()).toEqual([...METRIC_IDS].sort());
  });

  it('measures nothing on an empty run', () => {
    const measurements = measure(makeScoring());

    expect(measurements.linkValidity.value).toBeNull();
    expect(measurements.mustIncludeRecall.value).toBeNull();
    expect(measurements.stability.value).toBeNull();
    expect(measurements.selectionAgreement.value).toBeNull();
  });

  it('reads recall and leaks from the labels and the digest of each week', () => {
    const week = makeWeek();
    const markdown = renderDigest(makeDigest(week.items.slice(0, 4)), { disabledGuards: [] });
    const scoring = makeScoring({
      cases: { ...emptyCases(), weeks: [week] },
      run: { ...emptyRun(), weekRuns: [makeWeekRun(week, { markdown })] },
    });

    const measurements = measure(scoring);

    expect(measurements.mustIncludeRecall.value).toBe(4);
    expect(measurements.mustExcludeLeaks.value).toBe(0);
    expect(measurements.linkValidity.value).toBe(1);
  });

  describe('fact carry', () => {
    const week = makeWeek();
    const source = makeItem({ title: 'tool v1.2.0', summary: '' });
    const served = [source, ...week.items.slice(1)];
    const markdownWith = (title: string) =>
      renderDigest(
        {
          ...makeDigest([]),
          items: [{ ...makeDigestItem(source), title, summary: 'It ships.' }],
        },
        { disabledGuards: [] },
      );
    const scoring = (markdown: string, record = makeRunRecord()) =>
      makeScoring({
        cases: { ...emptyCases(), weeks: [week] },
        run: {
          ...emptyRun(),
          weekRuns: [makeWeekRun(week, { items: served, markdown, record })],
        },
      });

    it('is the share of shipped items whose facts are in their source', () => {
      expect(measure(scoring(markdownWith('tool v1.2.0'))).factCarry.value).toBe(1);
      expect(measure(scoring(markdownWith('tool v1.3.0'))).factCarry.value).toBe(0);
    });

    it('names the layers the digest passed, leaving out a guard the run had off', () => {
      const record = makeRunRecord({ disabledGuards: ['clefRubric'] });

      const result = measure(scoring(markdownWith('tool v1.3.0'), record)).factCarry;

      const [problem] = result.byWeek?.['2026-W40']?.problems ?? [];
      expect(problem).toContain('got past linkCheck, formatCheck, graniteGroundedness');
      expect(problem).not.toContain('clefRubric');
    });

    it('is not measured on an empty run', () => {
      expect(measure(makeScoring()).factCarry.value).toBeNull();
    });
  });

  describe('set size', () => {
    const week = makeWeek();
    const scoring = (weeks: number) =>
      makeScoring({
        cases: { ...emptyCases(), weeks: [week] },
        run: { ...emptyRun(), weekRuns: [makeWeekRun(week)] },
        minimums: { weeks, attacks: 0, grounding: 0, classifier: 0 },
      });

    it('marks a week metric incomplete on fewer weeks than the minimum', () => {
      const result = measure(scoring(6));

      expect(result.format.complete).toBe(false);
      expect(result.format.note).toBe('only 1 of 6 weeks');
    });

    it('marks fact carry incomplete on fewer weeks than the minimum, as format is', () => {
      const result = measure(scoring(6));

      expect(result.factCarry.complete).toBe(false);
      expect(result.factCarry.note).toContain('only 1 of 6 weeks');
    });

    it('leaves it complete on exactly the minimum', () => {
      expect(measure(scoring(1)).format.complete).toBeUndefined();
    });
  });

  describe('classifier accuracy', () => {
    const result = { expected: { area: 'a', relevance: 2 }, actual: { area: 'a', relevance: 2 } };
    const classifierCase = { item: makeWeek().items[0]!, expected: result.expected };
    const run = { ...emptyRun(), classifier: [result] };

    it('notes labels the maintainer has not reviewed yet', () => {
      const scoring = makeScoring({
        cases: { ...emptyCases(), classifier: { reviewed: false, cases: [classifierCase] } },
        run,
      });

      expect(measure(scoring).classifierAccuracy.note).toBe(
        'labels not reviewed by the maintainer yet',
      );
    });

    it('has no note once the labels are reviewed', () => {
      const scoring = makeScoring({
        cases: { ...emptyCases(), classifier: { reviewed: true, cases: [classifierCase] } },
        run,
      });

      expect(measure(scoring).classifierAccuracy.note).toBeUndefined();
    });

    it('has no note when there are no cases, reviewed or not', () => {
      const scoring = makeScoring({
        cases: { ...emptyCases(), classifier: { reviewed: false, cases: [] } },
      });

      expect(measure(scoring).classifierAccuracy.note).toBeUndefined();
    });
  });

  describe('judge metrics', () => {
    const scored = (score: number) =>
      makeRunRecord({
        winner: 'gemma',
        drafts: [
          {
            writer: 'gemma',
            passed: true,
            rejectedBy: [],
            score: { writer: 'gemma', score, byCriterion: {} },
          },
        ],
      });

    it("takes writing quality from the select step's scores when no eval judge ran", () => {
      const week = makeWeek();
      const run = {
        ...emptyRun(),
        weekRuns: [
          makeWeekRun(week, { record: scored(4) }),
          makeWeekRun(makeWeek('2026-W41'), { record: scored(5) }),
        ],
      };

      expect(measure(makeScoring({ run })).writingQuality.value).toBe(4.5);
    });

    it('takes writing quality from the eval judge when it ran', () => {
      const judged = { model: 'clef', scores: [3, 3], accuracies: [], failedWeeks: [] };

      const result = measure(makeScoring({ run: { ...emptyRun(), judged } }));

      expect(result.writingQuality.value).toBe(3);
    });

    it("carries the eval judge's mean accuracy next to writing quality", () => {
      const judged = { model: 'clef', scores: [3, 3], accuracies: [5, 4], failedWeeks: [] };

      const result = measure(makeScoring({ run: { ...emptyRun(), judged } }));

      expect(result.writingQuality.detail).toEqual({ meanAccuracy: 4.5 });
    });

    it('reports the calibrated selection agreement, from the file, for a profile with a judge', () => {
      const scoring = makeScoring({ cases: { ...emptyCases(), calibration: CALIBRATION } });

      expect(measure(scoring).selectionAgreement).toEqual({
        value: 0.8,
        note: 'from judge/calibration.json',
      });
    });

    it('counts how often each writer won', () => {
      const week = makeWeek();
      const run = { ...emptyRun(), weekRuns: [makeWeekRun(week, { record: scored(4) })] };

      expect(measure(makeScoring({ run })).writerWinRate.detail).toEqual({ gemma: 1 });
    });
  });
});
