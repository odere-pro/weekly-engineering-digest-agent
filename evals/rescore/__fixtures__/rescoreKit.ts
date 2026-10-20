import type { DecisionAnswer, GenerateRequest } from '../../../src/models/ModelProvider';
import type { Clock } from '../../../src/shared/clock';
import { makeConfig, makeItem } from '../../../test/builders';
import { FakeModelProvider, noopLogger } from '../../../test/fakes';
import type { EvalCases } from '../../cases/evalSet';
import type { RescoreReplayDeps } from '../replay/types';

export const AREA = 'AI models and tooling';
const TICK_MS = 2000;

/** A clock that advances two seconds on every reading. */
export function tickingClock(): Clock {
  let ms = Date.parse('2026-10-12T00:00:00Z');
  return {
    now: () => {
      ms += TICK_MS;
      return new Date(ms);
    },
  };
}

export const items = ['a', 'b', 'c', 'd', 'e'].map((id) => makeItem({ id, title: `Item ${id}` }));

/** One week W41 (a and b must include, c must exclude) and two classifier cases. */
export function cases(): EvalCases {
  return {
    weeks: [
      {
        weekId: '2026-W41',
        items,
        labels: { mustInclude: ['a', 'b'], mustExclude: ['c'] },
      },
    ],
    classifier: {
      reviewed: true,
      cases: [
        { id: 'k1', item: items[0]!, expected: { area: AREA, relevance: 3 } },
        { id: 'k2', item: items[2]!, expected: { area: 'other', relevance: 0 } },
      ],
    },
    attacks: [],
    grounding: [],
    calibration: null,
    sources: [],
  } as unknown as EvalCases;
}

/** The four decision answers of the classify step with relevance `level`. */
export function answers(level: number): Record<string, DecisionAnswer> {
  return {
    relevance: { type: 'score', level, score: level / 3, probabilities: {}, confidence: 1 },
    area: { type: 'choice', choice: AREA, probabilities: {}, confidence: 0.9 },
    hype: { type: 'yesno', probability: 0.1 },
    minorRelease: { type: 'yesno', probability: 0.1 },
  };
}

/** The decider gives every item 2; the writer knows c is noise and a is a must read. */
export function model(): FakeModelProvider {
  return new FakeModelProvider({
    decide: () => answers(2),
    generate: (request: GenerateRequest) =>
      JSON.stringify({
        items: [...request.prompt.matchAll(/<<<DATA (\w+)>>>/g)].map((m) => ({
          itemId: m[1],
          relevance: m[1] === 'c' ? 0 : m[1] === 'a' ? 3 : 2,
          area: m[1] === 'c' ? 'other' : AREA,
          confidence: 'high',
        })),
      }),
  });
}

export const deps = (fake: FakeModelProvider): RescoreReplayDeps => ({
  model: fake,
  config: makeConfig({ topN: 5 }),
  logger: noopLogger,
  clock: tickingClock(),
});
