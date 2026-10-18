import { describe, expect, it } from 'vitest';
import {
  AttackCaseSchema,
  ClassifierCasesFileSchema,
  GroundingCaseSchema,
  JudgeCalibrationSchema,
  METRIC_IDS,
  ScorecardSchema,
  WeekLabelsSchema,
} from './schema';
import { makeDraft, makeItem } from '../test/builders';

const FIVE = ['a', 'b', 'c', 'd', 'e'];

describe('WeekLabelsSchema', () => {
  it('accepts 5 must-include ids and any number of must-exclude ids', () => {
    const labels = WeekLabelsSchema.parse({ mustInclude: FIVE, mustExclude: ['x'], notes: 'ok' });
    expect(labels.mustInclude).toEqual(FIVE);
    expect(labels.mustExclude).toEqual(['x']);
  });

  it('defaults must-exclude to an empty list', () => {
    expect(WeekLabelsSchema.parse({ mustInclude: FIVE }).mustExclude).toEqual([]);
  });

  it('rejects an unlabeled template (no must-include ids yet)', () => {
    expect(
      WeekLabelsSchema.safeParse({ mustInclude: [], mustExclude: [], notes: '' }).success,
    ).toBe(false);
  });

  it('rejects a wrong number of must-include ids', () => {
    expect(WeekLabelsSchema.safeParse({ mustInclude: FIVE.slice(0, 4) }).success).toBe(false);
    expect(WeekLabelsSchema.safeParse({ mustInclude: [...FIVE, 'f'] }).success).toBe(false);
  });

  it('rejects duplicate must-include ids', () => {
    expect(WeekLabelsSchema.safeParse({ mustInclude: ['a', 'a', 'c', 'd', 'e'] }).success).toBe(
      false,
    );
  });

  it('rejects an id that is both must-include and must-exclude', () => {
    const result = WeekLabelsSchema.safeParse({ mustInclude: FIVE, mustExclude: ['c'] });
    expect(result.success).toBe(false);
  });
});

describe('ClassifierCasesFileSchema', () => {
  it('parses cases and defaults reviewed to false', () => {
    const file = ClassifierCasesFileSchema.parse({
      cases: [{ item: makeItem(), expected: { area: 'Platform engineering', relevance: 2 } }],
    });
    expect(file.reviewed).toBe(false);
    expect(file.cases).toHaveLength(1);
  });

  it('rejects a relevance outside 0-3', () => {
    const result = ClassifierCasesFileSchema.safeParse({
      cases: [{ item: makeItem(), expected: { area: 'x', relevance: 4 } }],
    });
    expect(result.success).toBe(false);
  });
});

describe('AttackCaseSchema', () => {
  it('parses an attack case with an optional expected blocker', () => {
    const parsed = AttackCaseSchema.parse({
      id: 'attack-01',
      item: makeItem(),
      kind: 'ignore-instructions',
      expectBlockedBy: 'clefPolicy',
    });
    expect(parsed.expectBlockedBy).toBe('clefPolicy');
  });

  it('accepts the link check as the expected blocker', () => {
    const parsed = AttackCaseSchema.parse({
      id: 'attack-02',
      item: makeItem(),
      kind: 'unknown-url',
      expectBlockedBy: 'linkCheck',
    });
    expect(parsed.expectBlockedBy).toBe('linkCheck');
  });

  it('rejects an unknown blocker', () => {
    const result = AttackCaseSchema.safeParse({
      id: 'attack-03',
      item: makeItem(),
      kind: 'x',
      expectBlockedBy: 'nope',
    });
    expect(result.success).toBe(false);
  });
});

describe('GroundingCaseSchema', () => {
  it('parses a draft with its sources and the planted item', () => {
    const items = [makeItem(), makeItem()];
    const parsed = GroundingCaseSchema.parse({
      id: 'grounding-01',
      draft: makeDraft(items),
      sources: items,
      plantedItemId: items[0]?.id,
    });
    expect(parsed.plantedItemId).toBe(items[0]?.id);
  });

  it('rejects a planted item that is not in the draft', () => {
    const items = [makeItem(), makeItem()];
    const result = GroundingCaseSchema.safeParse({
      id: 'grounding-02',
      draft: makeDraft(items),
      sources: items,
      plantedItemId: 'missing',
    });
    expect(result.success).toBe(false);
  });
});

describe('JudgeCalibrationSchema', () => {
  it('parses the two agreement numbers', () => {
    const parsed = JudgeCalibrationSchema.parse({ judgeAgreement: 0.9, selectionAgreement: 0.75 });
    expect(parsed.judgeAgreement).toBe(0.9);
  });

  it('rejects an agreement above 1', () => {
    expect(
      JudgeCalibrationSchema.safeParse({ judgeAgreement: 1.2, selectionAgreement: 0.5 }).success,
    ).toBe(false);
  });
});

describe('ScorecardSchema', () => {
  const metric = (id: string, failing = false): [string, unknown] => [
    id,
    {
      id,
      label: id,
      unit: 'ratio',
      value: failing ? 0 : 1,
      gate: failing
        ? { kind: 'hard', direction: 'atLeast', threshold: 1, needsJudge: false }
        : { kind: 'none' },
      pass: failing ? false : null,
    },
  ];

  const base = {
    profile: 'quality',
    date: '2026-10-16T09:00:00.000Z',
    weeks: ['2026-W40'],
    counts: { weeks: 1, classifier: 0, attacks: 0, grounding: 0 },
    judgeAgreement: null,
    models: { classify: 'clef:latest', write: ['gemma4:31b-mlx'], judge: null },
    hardGatesPassed: true,
    timings: { totalMs: 10, byWeekMs: { '2026-W40': 10 } },
  };

  it('parses a scorecard with every metric', () => {
    const scorecard = { ...base, metrics: Object.fromEntries(METRIC_IDS.map((id) => metric(id))) };
    expect(ScorecardSchema.parse(scorecard).profile).toBe('quality');
  });

  it('rejects a scorecard that misses a metric', () => {
    const scorecard = {
      ...base,
      metrics: Object.fromEntries(METRIC_IDS.slice(1).map((id) => metric(id))),
    };
    expect(ScorecardSchema.safeParse(scorecard).success).toBe(false);
  });

  it('rejects hardGatesPassed when a hard gate failed', () => {
    const metrics = Object.fromEntries(METRIC_IDS.map((id) => metric(id, id === 'format')));
    expect(ScorecardSchema.safeParse({ ...base, metrics }).success).toBe(false);
    expect(ScorecardSchema.safeParse({ ...base, hardGatesPassed: false, metrics }).success).toBe(
      true,
    );
  });
});
