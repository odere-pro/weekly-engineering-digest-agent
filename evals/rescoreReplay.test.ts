import { describe, expect, it } from 'vitest';
import {
  formatResult,
  holdoutOf,
  replayRescore,
  runCli,
  type RescoreResult,
} from './rescoreReplay';
import type { Calibration } from '../src/process/calibration';
import type { EvalCases } from './cases/evalSet';
import type { Clock } from '../src/shared/clock';
import type { DecisionAnswer, GenerateRequest } from '../src/models/ModelProvider';
import { makeConfig, makeItem } from '../test/builders';
import { FakeModelProvider, noopLogger } from '../test/fakes';

const AREA = 'AI models and tooling';
const TICK_MS = 2000;

/** A clock that advances two seconds on every reading. */
function tickingClock(): Clock {
  let ms = Date.parse('2026-10-12T00:00:00Z');
  return {
    now: () => {
      ms += TICK_MS;
      return new Date(ms);
    },
  };
}

const items = ['a', 'b', 'c', 'd', 'e'].map((id) => makeItem({ id, title: `Item ${id}` }));

function cases(): EvalCases {
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

function answers(level: number): Record<string, DecisionAnswer> {
  return {
    relevance: { type: 'score', level, score: level / 3, probabilities: {}, confidence: 1 },
    area: { type: 'choice', choice: AREA, probabilities: {}, confidence: 0.9 },
    hype: { type: 'yesno', probability: 0.1 },
    minorRelease: { type: 'yesno', probability: 0.1 },
  };
}

/** The decider gives every item 2; the writer knows c is noise and a is a must read. */
function model(): FakeModelProvider {
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

const deps = (fake: FakeModelProvider) => ({
  model: fake,
  config: makeConfig({ topN: 5 }),
  logger: noopLogger,
  clock: tickingClock(),
});

describe('replayRescore', () => {
  it('with the flag off makes no writer call and keeps the decider ranking', async () => {
    const fake = model();

    const result = await replayRescore(cases(), deps(fake), false);

    expect(fake.generateCalls).toHaveLength(0);
    expect(result).toMatchObject({
      rescoreWithWriter: false,
      weeks: 1,
      mustIncludeRecall: 2,
      mustExcludeLeaks: 1,
      classifierAccuracy: 0,
    });
    expect(result.secondsPerWeek).toBe(2);
  });

  it('with the flag on rescoring removes the leak and fixes the cases', async () => {
    const fake = model();

    const result = await replayRescore(cases(), deps(fake), true);

    expect(fake.generateCalls.every((call) => call.role === 'write')).toBe(true);
    expect(result).toMatchObject({
      rescoreWithWriter: true,
      mustIncludeRecall: 2,
      mustExcludeLeaks: 0,
      classifierAccuracy: 1,
    });
  });

  it('with pairwise on re-ranks the survivors with the judge and counts the calls', async () => {
    const fake = new FakeModelProvider({
      // The classifier gives every item 2. The pairwise judge always prefers the item whose
      // title is alphabetically later ("Item e" beats "Item a").
      decide: (request) => {
        if (!('prefer' in request.questions)) return answers(2);
        const titles = [...request.state.matchAll(/Title: Item (\w)/g)].map((m) => m[1] ?? '');
        return {
          prefer: { type: 'yesno', probability: (titles[0] ?? '') > (titles[1] ?? '') ? 1 : 0 },
        };
      },
    });
    const set = cases();
    set.weeks = [{ weekId: '2026-W41', items, labels: { mustInclude: ['e'], mustExclude: [] } }];
    set.classifier = { reviewed: true, cases: [] };
    const config = makeConfig({ topN: 5 });

    const off = await replayRescore(set, { ...deps(fake), config }, false);
    const on = await replayRescore(set, { ...deps(fake), config, pairwise: true }, false);

    expect(off).not.toHaveProperty('pairwise');
    expect(on.pairwise).toBe(true);
    // All items score 2, so rank is a tie and "off" keeps the date/id order (e is last).
    // The judge prefers later titles, so "on" moves e to the front.
    expect(off.mustIncludeRecall).toBe(1);
    expect(on.mustIncludeRecall).toBe(1);
    const pairwiseCalls = fake.decideCalls.filter((call) => 'prefer' in call.questions);
    expect(pairwiseCalls.length).toBeLessThanOrEqual(40);
    expect(fake.decideCalls.some((call) => 'prefer' in call.questions)).toBe(true);
  });

  it('serves only each source newest items up to the cap', async () => {
    const fake = model();
    const config = makeConfig({ topN: 5, maxItemsPerSource: 2 });
    const dated = ['a', 'b', 'c'].map((id, i) =>
      makeItem({ id, publishedAt: `2026-10-0${i + 1}T09:00:00Z` }),
    );
    const set = cases();
    set.weeks = [
      { weekId: '2026-W41', items: dated, labels: { mustInclude: ['a'], mustExclude: [] } },
    ];
    set.classifier = { reviewed: true, cases: [] };

    const result = await replayRescore(set, { ...deps(fake), config }, false);

    // a is the oldest, so outside the cap: it is neither found nor counted.
    expect(result.mustIncludeRecall).toBe(0);
    expect(fake.decideCalls).toHaveLength(2);
    expect(result.classifierAccuracy).toBeNull();
  });
});

describe('replayRescore with a calibration', () => {
  // The decider gives every item 2, so only the area bias can tell them apart.
  const calibration: Calibration = {
    version: 1,
    profile: 'light',
    points: [{ raw: 2, calibrated: 2 }],
    areaBias: { [AREA.toLowerCase()]: -0.5 },
  };

  it('is the same as no calibration when none is given', async () => {
    const plain = await replayRescore(cases(), deps(model()), false);
    const undef = await replayRescore(cases(), { ...deps(model()), calibration: undefined }, false);
    expect(JSON.stringify(undef)).toBe(JSON.stringify(plain));
  });

  it('ranks and scores the classifier cases on the calibrated relevance', async () => {
    const result = await replayRescore(cases(), { ...deps(model()), calibration }, false);
    // 2 - 0.5 = 1.5 still passes minRelevance 1.5; the case expecting 3 is now 1.5 away.
    expect(result.mustIncludeRecall).toBe(2);
    expect(result.classifierAccuracy).toBe(0);
    expect(result.calibrated).toBe(true);
  });

  it('drops items that fall under the floor after calibration', async () => {
    const lower = { ...calibration, areaBias: { [AREA.toLowerCase()]: -1 } };
    const result = await replayRescore(cases(), { ...deps(model()), calibration: lower }, false);
    expect(result.mustIncludeRecall).toBe(0);
  });
});

describe('holdoutOf', () => {
  it('keeps the named weeks and every third classifier case', () => {
    const set = cases();
    const second = { ...set.weeks[0]!, weekId: '2026-W40' };
    const base = set.classifier.cases[0]!;
    const many = Array.from({ length: 6 }, (_, i) => ({
      ...base,
      item: { ...base.item, id: `k${i}` },
    }));
    const out = holdoutOf(
      { ...set, weeks: [second, set.weeks[0]!], classifier: { reviewed: true, cases: many } },
      ['2026-W41'],
    );
    expect(out.weeks.map((w) => w.weekId)).toEqual(['2026-W41']);
    expect(out.classifier.cases.map((c) => c.item.id)).toEqual(['k2', 'k5']);
  });
});

describe('formatResult', () => {
  it('prints the three numbers and the time', () => {
    const result: RescoreResult = {
      rescoreWithWriter: true,
      weeks: 6,
      mustIncludeRecall: 1.5,
      mustExcludeLeaks: 0.25,
      classifierAccuracy: 0.3,
      secondsPerWeek: 12.34,
    };

    const text = formatResult('light', result);

    expect(text).toContain('rescoreWithWriter: on');
    expect(text).toContain('must-include recall: 1.50 of 5');
    expect(text).toContain('must-exclude leaks: 0.25');
    expect(text).toContain('classifier accuracy: 30.0%');
    expect(text).toContain('seconds per week: 12.3');
    expect(
      formatResult('light', { ...result, classifierAccuracy: null, mustIncludeRecall: null }),
    ).toContain('classifier accuracy: n/a');
  });
});

describe('runCli', () => {
  const result: RescoreResult = {
    rescoreWithWriter: false,
    weeks: 1,
    mustIncludeRecall: 1,
    mustExcludeLeaks: 0,
    classifierAccuracy: 0.5,
    secondsPerWeek: 1,
  };

  function io() {
    const out: string[] = [];
    const err: string[] = [];
    const seen: boolean[] = [];
    return {
      out,
      err,
      seen,
      overrides: {
        casesDir: 'unused',
        loadCases: () => Promise.resolve(cases()),
        run: (_o: unknown, _c: unknown, rescore: boolean) => {
          seen.push(rescore);
          return Promise.resolve(result);
        },
        stdout: (t: string) => out.push(t),
        stderr: (t: string) => err.push(t),
      },
    };
  }

  it('prints the result for --flag on and passes the flag through', async () => {
    const kit = io();

    const code = await runCli(['--profile', 'light', '--flag', 'on'], kit.overrides);

    expect(code).toBe(0);
    expect(kit.seen).toEqual([true]);
    expect(kit.out.join('')).toContain('profile: light');
  });

  it.each([[[]], [['--profile', 'light']], [['--profile', 'nope', '--flag', 'on']], [['--bogus']]])(
    'exits 2 with the usage for %j',
    async (args) => {
      const kit = io();

      expect(await runCli(args, kit.overrides)).toBe(2);
      expect(kit.err.join('')).toContain('Usage');
    },
  );

  it('loads --calibration and restricts to --holdout weeks', async () => {
    const kit = io();
    const seen: unknown[] = [];
    const calibration: Calibration = {
      version: 1,
      profile: 'light',
      points: [{ raw: 2, calibrated: 2 }],
      areaBias: {},
    };

    const code = await runCli(
      ['--profile', 'light', '--flag', 'off', '--calibration', 'c.json', '--holdout', '2026-W40'],
      {
        ...kit.overrides,
        loadCalibration: () => Promise.resolve(calibration),
        run: (o: unknown, c: EvalCases) => {
          seen.push(o, c.weeks.length);
          return Promise.resolve(result);
        },
      },
    );

    expect(code).toBe(0);
    expect(seen).toEqual([
      { profile: 'light', config: undefined, calibration, pairwise: false },
      0,
    ]);
  });

  it('passes --pairwise on through and rejects other values', async () => {
    const kit = io();
    const seen: unknown[] = [];
    const run = (o: unknown) => {
      seen.push(o);
      return Promise.resolve(result);
    };

    expect(
      await runCli(['--profile', 'light', '--flag', 'off', '--pairwise', 'on'], {
        ...kit.overrides,
        run,
      }),
    ).toBe(0);
    expect(seen).toEqual([
      { profile: 'light', config: undefined, calibration: undefined, pairwise: true },
    ]);
    expect(
      await runCli(['--profile', 'light', '--flag', 'off', '--pairwise', 'maybe'], kit.overrides),
    ).toBe(2);
  });

  it('exits 1 and says why when the run fails', async () => {
    const kit = io();

    const code = await runCli(['--profile', 'light', '--flag', 'off'], {
      ...kit.overrides,
      run: () => Promise.reject(new Error('ollama down')),
    });

    expect(code).toBe(1);
    expect(kit.err.join('')).toContain('ollama down');
  });
});
