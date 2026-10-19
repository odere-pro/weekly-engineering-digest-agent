import { makeItem } from '../../../test/builders';
import type { EvalCases } from '../../cases/evalSet';
import type { RawCapture } from '../../thresholds/capture/schemas';
import type { Sample } from '../fit/types';

export const sample = (raw: number, target: number, area = 'a'): Sample => ({
  raw,
  target,
  area,
});

const ok = (relevance: number, area = 'a') => ({
  relevance,
  area,
  areaConfidence: 0.9,
  hype: 0.1,
  minorRelease: 0.1,
});

const weekRecord = (
  weekId: string,
  itemId: string,
  label: 'mustInclude' | 'mustExclude' | null,
  relevance: number,
) => ({ itemId, weekId, label, result: ok(relevance) });

/**
 * A small raw capture: six classifier cases (c4 failed) and five week items over W36 and W40.
 * With `holdoutWeeks: ['2026-W40']` and stride 3, c2 and c5 and the two W40 items are held out.
 */
export function rawCapture(): RawCapture {
  return {
    profile: 'light',
    capturedAt: '2026-10-17T10:00:00.000Z',
    ollamaVersion: null,
    models: { classify: 'm', guardPolicy: 'm', guardRisk: 'm' },
    focusAreas: ['a'],
    baseline: { minRelevance: 1, maxHype: 1, maxMinorRelease: 1, guardFlag: 0.5 },
    classifier: [0, 1, 2, 3, 4, 5].map((i) => ({
      itemId: `c${i}`,
      expected: { area: 'a', relevance: i % 4 },
      result: i === 4 ? { error: 'boom' } : ok(1 + (i % 4) / 2),
    })),
    weekItems: [
      weekRecord('2026-W40', 'x1', 'mustInclude', 1),
      weekRecord('2026-W40', 'x2', 'mustExclude', 2),
      weekRecord('2026-W36', 'y1', 'mustInclude', 2),
      weekRecord('2026-W36', 'y2', 'mustExclude', 1),
      weekRecord('2026-W36', 'y3', null, 1.5),
    ],
    inputGuards: [],
    outputGuards: [],
    timingsMs: {},
  } as unknown as RawCapture;
}

/**
 * A capture the fit helps with default thresholds (minRelevance 1.5): the decider scores a must
 * include 1.4 and a must exclude 1.0, in both W36 (train) and W40 (holdout). Without the file
 * nothing passes; with it the must include does.
 */
export function liftingCapture(): RawCapture {
  return {
    ...rawCapture(),
    classifier: [],
    weekItems: [
      weekRecord('2026-W36', 'y1', 'mustInclude', 1.4),
      weekRecord('2026-W36', 'y2', 'mustExclude', 1),
      weekRecord('2026-W40', 'x1', 'mustInclude', 1.4),
      weekRecord('2026-W40', 'x2', 'mustExclude', 1),
    ],
  };
}

/** The holdout side of `rawCapture()`: the two W40 week items and no classifier case. */
export function holdoutCapture(): RawCapture {
  const capture = rawCapture();
  return {
    ...capture,
    classifier: [],
    weekItems: capture.weekItems.filter((record) => record.weekId === '2026-W40'),
  };
}

/** Week W40 with items x1 (must include) and x2 (must exclude), no classifier case. */
export function weekCases(): EvalCases {
  const items = ['x1', 'x2'].map((id) => makeItem({ id, title: `Thing ${id}` }));
  return {
    weeks: [{ weekId: '2026-W40', items, labels: { mustInclude: ['x1'], mustExclude: ['x2'] } }],
    classifier: { reviewed: true, cases: [] },
  } as unknown as EvalCases;
}
