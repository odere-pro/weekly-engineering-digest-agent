// What W5-04 added to the scorecard and the calibration file is optional, so scorecards and
// calibrations written before it still parse (the committed v0.1.0 baseline among them).
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  JudgeCalibrationSchema,
  METRIC_IDS,
  MetricResultSchema,
  ScorecardSchema,
  withoutItem,
} from './schema';
import { makeDraft, makeItem } from '../test/builders';

const SCORECARDS_DIR = join(import.meta.dirname, 'scorecards');

const metric = (id: string): [string, unknown] => [
  id,
  { id, label: id, unit: 'ratio', value: 1, gate: { kind: 'none' }, pass: null },
];

const base = {
  profile: 'light',
  date: '2026-10-16T09:00:00.000Z',
  weeks: ['2026-W40'],
  counts: { weeks: 1, classifier: 0, attacks: 0, grounding: 0 },
  judgeAgreement: null,
  models: { classify: 'clef:latest' },
  hardGatesPassed: true,
  timings: { totalMs: 10, byWeekMs: { '2026-W40': 10 } },
};

describe('committed scorecards', () => {
  it('still parse after the schema grew', async () => {
    const files = (await readdir(SCORECARDS_DIR)).filter((name) => name.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const json: unknown = JSON.parse(await readFile(join(SCORECARDS_DIR, file), 'utf8'));
      const parsed = ScorecardSchema.safeParse(json);
      expect(parsed.success, file).toBe(true);
    }
  });

  it('read back with every metric, the ones recorded later marked as not recorded', async () => {
    const json: unknown = JSON.parse(
      await readFile(join(SCORECARDS_DIR, '2026-10-17-light.json'), 'utf8'),
    );
    const card = ScorecardSchema.parse(json);

    expect(Object.keys(card.metrics).sort()).toEqual([...METRIC_IDS].sort());
    expect(card.metrics.guardAttackRecall).toMatchObject({
      value: null,
      pass: null,
      note: 'not recorded in this scorecard',
    });
    // The recorded numbers are untouched.
    expect(card.metrics.format.value).toBeCloseTo(2 / 3);
  });
});

describe('a scorecard written before guardAttackRecall existed', () => {
  const older = Object.fromEntries(
    METRIC_IDS.filter((id) => id !== 'guardAttackRecall').map((id) => metric(id)),
  );

  it('parses', () => {
    expect(ScorecardSchema.safeParse({ ...base, metrics: older }).success).toBe(true);
  });

  it('keeps a guardAttackRecall result it does carry', () => {
    const metrics = {
      ...older,
      guardAttackRecall: {
        id: 'guardAttackRecall',
        label: 'Guard attack recall',
        unit: 'ratio',
        value: 0.7,
        gate: { kind: 'soft', direction: 'atLeast', threshold: 0.9, needsJudge: false },
        pass: false,
      },
    };

    const card = ScorecardSchema.parse({ ...base, metrics });

    expect(card.metrics.guardAttackRecall.value).toBe(0.7);
  });

  it('still rejects a scorecard that misses a metric that always existed', () => {
    const { linkValidity: _dropped, ...rest } = older;
    expect(ScorecardSchema.safeParse({ ...base, metrics: rest }).success).toBe(false);
  });

  it('rejects metrics that are not an object', () => {
    expect(ScorecardSchema.safeParse({ ...base, metrics: 'none' }).success).toBe(false);
  });
});

describe('a scorecard written before factCarry existed', () => {
  const older = Object.fromEntries(
    METRIC_IDS.filter((id) => id !== 'factCarry').map((id) => metric(id)),
  );

  it('parses, with factCarry read as not recorded', () => {
    const card = ScorecardSchema.parse({ ...base, metrics: older });

    expect(card.metrics.factCarry).toMatchObject({
      id: 'factCarry',
      label: 'Fact carry',
      unit: 'ratio',
      value: null,
      gate: { kind: 'none' },
      pass: null,
      note: 'not recorded in this scorecard',
    });
  });

  it('keeps a factCarry result it does carry', () => {
    const metrics = {
      ...older,
      factCarry: {
        id: 'factCarry',
        label: 'Fact carry',
        unit: 'ratio',
        value: 0.8,
        gate: { kind: 'soft', direction: 'atLeast', threshold: 1, needsJudge: false },
        pass: false,
      },
    };

    const card = ScorecardSchema.parse({ ...base, metrics });

    expect(card.metrics.factCarry.value).toBe(0.8);
  });
});

describe('MetricResultSchema extras', () => {
  const plain = {
    id: 'format',
    label: 'Format',
    unit: 'ratio',
    value: 0.5,
    gate: { kind: 'none' },
    pass: null,
  };

  it('accepts the per-week detail and the per-run item ids', () => {
    const parsed = MetricResultSchema.parse({
      ...plain,
      byWeek: {
        '2026-W39': { status: 'failed', problems: ['title is empty'], problemCount: 1 },
        '2026-W40': { status: 'ok', problems: [], problemCount: 0 },
        '2026-W41': { status: 'no-digest', problems: [], problemCount: 0 },
      },
      itemIdsByRun: [['a', 'b'], []],
    });

    expect(parsed.byWeek?.['2026-W39']?.problems).toEqual(['title is empty']);
    expect(parsed.itemIdsByRun).toEqual([['a', 'b'], []]);
  });

  it('parses a result that has neither', () => {
    const parsed = MetricResultSchema.parse(plain);
    expect(parsed.byWeek).toBeUndefined();
    expect(parsed.itemIdsByRun).toBeUndefined();
  });

  it('rejects a week status it does not know', () => {
    const result = MetricResultSchema.safeParse({
      ...plain,
      byWeek: { '2026-W39': { status: 'weird', problems: [], problemCount: 0 } },
    });
    expect(result.success).toBe(false);
  });
});

describe('JudgeCalibrationSchema extras', () => {
  it('still parses the two agreement numbers alone', () => {
    const parsed = JudgeCalibrationSchema.parse({ judgeAgreement: 0.9, selectionAgreement: 0.8 });
    expect(parsed.spearman).toBeUndefined();
  });

  it('accepts the rank correlation, the mean difference and the judge tag', () => {
    const parsed = JudgeCalibrationSchema.parse({
      judgeAgreement: 0.9,
      selectionAgreement: 0.8,
      gradedDigests: 10,
      spearman: 0.82,
      meanAbsoluteDifference: 0.4,
      judge: 'clef:latest',
    });
    expect(parsed).toMatchObject({ spearman: 0.82, meanAbsoluteDifference: 0.4 });
  });

  it('accepts an undefined correlation as null', () => {
    const parsed = JudgeCalibrationSchema.parse({
      judgeAgreement: 1,
      selectionAgreement: 1,
      spearman: null,
    });
    expect(parsed.spearman).toBeNull();
  });

  it('rejects a correlation outside -1 to 1', () => {
    expect(
      JudgeCalibrationSchema.safeParse({
        judgeAgreement: 1,
        selectionAgreement: 1,
        spearman: 1.5,
      }).success,
    ).toBe(false);
  });
});

describe('withoutItem', () => {
  it('returns the draft without the item, leaving the original untouched', () => {
    const items = [makeItem(), makeItem(), makeItem()];
    const draft = makeDraft(items);

    const control = withoutItem(draft, items[1]!.id);

    expect(control?.digest.items.map((entry) => entry.itemId)).toEqual([
      items[0]!.id,
      items[2]!.id,
    ]);
    expect(control?.writer).toBe(draft.writer);
    expect(draft.digest.items).toHaveLength(3);
  });

  it('is undefined when nothing else is left', () => {
    const items = [makeItem()];
    expect(withoutItem(makeDraft(items), items[0]!.id)).toBeUndefined();
  });

  it('returns an equal draft when the item is not in it', () => {
    const items = [makeItem(), makeItem()];
    const draft = makeDraft(items);
    expect(withoutItem(draft, 'missing')).toEqual(draft);
  });
});
