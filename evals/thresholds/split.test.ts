import { describe, expect, it } from 'vitest';
import type { RawCapture } from './capture/schemas';
import {
  GAP_WARNING,
  NO_SPLIT,
  compareSides,
  defaultSplit,
  parseHoldoutWeeks,
  scoreSide,
  splitCapture,
  splitLines,
} from './split';
import { DigestError } from '../../src/shared/errors';

const WEEKS = ['2026-W36', '2026-W37', '2026-W38', '2026-W39', '2026-W40', '2026-W41'];
const OK = { area: 'a', areaConfidence: 0.9, hype: 0.1, minorRelease: 0.1 };

function capture(overrides: Partial<RawCapture> = {}): RawCapture {
  return {
    profile: 'light',
    capturedAt: '2026-10-17T10:00:00.000Z',
    ollamaVersion: null,
    models: { classify: 'c', guardPolicy: 'p', guardRisk: 'g' },
    focusAreas: ['a'],
    baseline: { minRelevance: 1.5, maxHype: 0.6, maxMinorRelease: 0.75, guardFlag: 0.35 },
    classifier: Array.from({ length: 9 }, (_, i) => ({
      itemId: `case-${i}`,
      expected: { area: 'a', relevance: i % 4 },
      result: { ...OK, relevance: i % 4 },
    })),
    weekItems: WEEKS.map((weekId) => ({
      itemId: `item-${weekId}`,
      weekId: weekId as `${number}-W${number}`,
      label: null,
      result: { ...OK, relevance: 2 },
    })),
    inputGuards: [
      ...WEEKS.map((week) => ({
        itemId: `clean-${week}`,
        title: 't',
        kind: 'clean' as const,
        from: week,
        clefPolicy: { probability: 0.1 },
        graniteRisk: { flagged: false },
      })),
      ...Array.from({ length: 6 }, (_, i) => ({
        itemId: `attack-${i}`,
        title: 't',
        kind: 'attack' as const,
        from: `attack-0${i}`,
        clefPolicy: { probability: 0.9 },
        graniteRisk: { flagged: i === 0 },
      })),
    ],
    outputGuards: ['g1', 'g2', 'g3'].flatMap((caseId) => [
      { caseId, draft: 'planted' as const, clefRubric: { probability: 0.2 } },
      { caseId, draft: 'control' as const, clefRubric: { probability: 0.1 } },
    ]),
    timingsMs: {},
    ...overrides,
  };
}

describe('defaultSplit', () => {
  it('holds out the two newest recorded weeks and every third classifier case', () => {
    expect(defaultSplit(capture())).toEqual({
      holdoutWeeks: ['2026-W40', '2026-W41'],
      caseStride: 3,
    });
  });

  it('always leaves one week to train on', () => {
    const two = capture({
      weekItems: [],
      inputGuards: capture().inputGuards.filter((g) => g.kind === 'attack' || g.from < '2026-W38'),
    });
    expect(defaultSplit(two).holdoutWeeks).toEqual(['2026-W37']);
    expect(defaultSplit(capture({ weekItems: [], inputGuards: [] })).holdoutWeeks).toEqual([]);
  });
});

describe('splitCapture', () => {
  const split = defaultSplit(capture());

  it('is deterministic', () => {
    expect(splitCapture(capture(), split)).toEqual(splitCapture(capture(), split));
  });

  it('puts every third classifier case in the holdout, starting with the third', () => {
    const { train, holdout } = splitCapture(capture(), split);
    expect(holdout.classifier.map((r) => r.itemId)).toEqual(['case-2', 'case-5', 'case-8']);
    expect(train.classifier).toHaveLength(6);
  });

  it('is disjoint and complete on every kind of record', () => {
    const raw = capture();
    const { train, holdout } = splitCapture(raw, split);
    const ids = (c: RawCapture): string[] => [
      ...c.classifier.map((r) => r.itemId),
      ...c.weekItems.map((r) => r.itemId),
      ...c.inputGuards.map((r) => r.itemId),
      ...c.outputGuards.map((r) => `${r.caseId}/${r.draft}`),
    ];
    const all = ids(raw);
    expect([...ids(train), ...ids(holdout)].sort()).toEqual([...all].sort());
    expect(ids(train).filter((id) => ids(holdout).includes(id))).toEqual([]);
  });

  it('holds out whole weeks, for week items and clean input guards', () => {
    const { train, holdout } = splitCapture(capture(), split);
    expect(holdout.weekItems.map((r) => r.weekId)).toEqual(['2026-W40', '2026-W41']);
    expect(train.weekItems.map((r) => r.weekId)).not.toContain('2026-W40');
    expect(holdout.inputGuards.filter((g) => g.kind === 'clean').map((g) => g.from)).toEqual([
      '2026-W40',
      '2026-W41',
    ]);
  });

  it('holds out every third attack and keeps a grounding case together', () => {
    const { train, holdout } = splitCapture(capture(), split);
    expect(holdout.inputGuards.filter((g) => g.kind === 'attack').map((g) => g.itemId)).toEqual([
      'attack-2',
      'attack-5',
    ]);
    expect(holdout.outputGuards.map((r) => r.caseId)).toEqual(['g3', 'g3']);
    expect(train.outputGuards.map((r) => r.caseId)).toEqual(['g1', 'g1', 'g2', 'g2']);
  });

  it('holds nothing out with NO_SPLIT', () => {
    const raw = capture();
    const { train, holdout } = splitCapture(raw, NO_SPLIT);
    expect(train).toEqual(raw);
    expect(holdout.classifier).toEqual([]);
    expect(holdout.inputGuards).toEqual([]);
  });

  it('refuses a holdout week the capture does not have, or one that leaves nothing to train on', () => {
    expect(() => splitCapture(capture(), { holdoutWeeks: ['2026-W01'], caseStride: 3 })).toThrow(
      DigestError,
    );
    expect(() => splitCapture(capture(), { holdoutWeeks: WEEKS, caseStride: 3 })).toThrow(
      /leaves no week to pick on/,
    );
  });
});

describe('parseHoldoutWeeks', () => {
  it('reads a comma-separated list of week ids', () => {
    expect(parseHoldoutWeeks('2026-W41, 2026-W40')).toEqual(['2026-W40', '2026-W41']);
  });

  it('rejects anything that is not a week id', () => {
    expect(() => parseHoldoutWeeks('last week')).toThrow(DigestError);
    expect(() => parseHoldoutWeeks('')).toThrow(DigestError);
  });
});

describe('scoreSide', () => {
  const thresholds = { minRelevance: 1.5, maxHype: 0.6, maxMinorRelease: 0.75, guardFlag: 0.35 };

  it('scores the filter, the classifier and the false blocks of one side', () => {
    const score = scoreSide(capture(), thresholds);
    expect(score.filterAccuracy).toBe(1);
    expect(score.classifierAccuracy).toBe(1);
    expect(score.falseBlocks).toBe(0);
    expect(score.attackRecall).toBeCloseTo(1);
  });

  it('reports null where a side has nothing to measure', () => {
    const { holdout } = splitCapture(capture(), NO_SPLIT);
    expect(scoreSide(holdout, thresholds)).toEqual({
      classifierAccuracy: null,
      filterAccuracy: null,
      falseBlocks: null,
      attackRecall: null,
    });
  });

  it('takes the worst false-block rate over the guards', () => {
    const raw = capture({
      inputGuards: capture().inputGuards.map((g) =>
        g.kind === 'clean' ? { ...g, clefPolicy: { probability: 0.9 } } : g,
      ),
    });
    expect(scoreSide(raw, thresholds).falseBlocks).toBe(1);
  });
});

describe('compareSides and splitLines', () => {
  const side = (filterAccuracy: number | null) => ({
    classifierAccuracy: 0.8,
    filterAccuracy,
    falseBlocks: 0,
    attackRecall: 0.7,
  });

  it('reports train minus holdout and warns only above the gap limit', () => {
    expect(GAP_WARNING).toBe(0.1);
    const small = compareSides(side(0.9), side(0.85));
    expect(small.gap.filterAccuracy).toBeCloseTo(0.05);
    expect(small.warnings).toEqual([]);
    const big = compareSides(side(0.9), side(0.7));
    expect(big.gap.filterAccuracy).toBeCloseTo(0.2);
    expect(big.warnings).toHaveLength(1);
    expect(big.warnings[0]).toMatch(/filter accuracy.*0\.200.*0\.1/);
  });

  it('does not warn at exactly the limit, or when a side is empty', () => {
    expect(compareSides(side(0.8), side(0.7)).warnings).toEqual([]);
    const empty = compareSides(side(0.9), side(null));
    expect(empty.gap.filterAccuracy).toBeNull();
    expect(empty.warnings).toEqual([]);
  });

  it('warns when the holdout false blocks rise by more than the limit', () => {
    const rise = compareSides(side(0.9), { ...side(0.9), falseBlocks: 0.2 });
    expect(rise.gap.falseBlocks).toBeCloseTo(0.2);
    expect(rise.warnings[0]).toMatch(/false blocks/);
  });

  it('prints the sides next to each other, then the gap, with the warning after it', () => {
    const lines = splitLines(side(0.9), side(0.7), compareSides(side(0.9), side(0.7)));
    const text = lines.join('\n');
    expect(text).toMatch(/train\s+holdout\s+gap/);
    expect(text).toMatch(/filter accuracy\s+0\.900\s+0\.700\s+0\.200/);
    expect(lines.at(-1)).toMatch(/^WARNING/);
  });
});
