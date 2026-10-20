// A Scoring (the input of measure and buildScorecard) built by hand, so scoring is tested
// without a replay: start from an empty run and override only what the test is about.
import { PROFILES } from '../../../src/config/profiles';
import { makeItem } from '../../../test/builders';
import type { EvalCases, EvalSetSize, EvalWeek } from '../../cases/evalSet';
import { makeApp } from '../../evalKit';
import { makeReplay } from '../../replay/__fixtures__/replayKit';
import type { Replay } from '../../replay/replay';
import type { EvalRun, Scoring, WeekRun } from '../types';

/** Lifts the spec's minimum set sizes: a hand-built run is tiny. */
const NO_MINIMUMS: EvalSetSize = { weeks: 0, attacks: 0, grounding: 0, classifier: 0 };

export const emptyCases = (): EvalCases => ({
  weeks: [],
  classifier: { reviewed: true, cases: [] },
  attacks: [],
  grounding: [],
  calibration: null,
  sources: [],
});

export const emptyRun = (): EvalRun => ({
  weekRuns: [],
  stabilityIds: [],
  attack: undefined,
  attackBaseline: undefined,
  classifier: [],
  grounding: { outcomes: [], tallies: {}, disabledChecks: [] },
  judged: undefined,
  sources: [],
});

/** A week of six items whose labels name items by position: include 1 to 5, exclude 6. */
export function makeWeek(weekId = '2026-W40'): EvalWeek {
  const items = Array.from({ length: 6 }, () => makeItem({ sourceId: 'feed-a' }));
  return {
    weekId,
    items,
    labels: {
      mustInclude: items.slice(0, 5).map((item) => item.id),
      mustExclude: [items[5]!.id],
    },
  };
}

/** A week run whose replay served the whole week and wrote no digest unless one is given. */
export function makeWeekRun(week: EvalWeek, overrides: Partial<Replay> = {}): WeekRun {
  return {
    week,
    run: makeReplay({
      weekId: week.weekId,
      items: week.items,
      served: new Set(week.items.map((item) => item.id)),
      ...overrides,
    }),
  };
}

export function makeScoring(overrides: Partial<Scoring> = {}): Scoring {
  return {
    profile: 'quality',
    only: undefined,
    cases: emptyCases(),
    run: emptyRun(),
    app: makeApp({}, PROFILES.quality).deps,
    minimums: NO_MINIMUMS,
    startMs: Date.parse('2026-10-16T09:00:00Z'),
    endMs: Date.parse('2026-10-16T09:00:05Z'),
    ...overrides,
  };
}
