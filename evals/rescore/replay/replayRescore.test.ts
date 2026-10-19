import { describe, expect, it } from 'vitest';
import type { Calibration } from '../../../src/process/calibration';
import { makeConfig, makeItem } from '../../../test/builders';
import { FakeModelProvider } from '../../../test/fakes';
import { AREA, answers, cases, deps, items, model } from '../__fixtures__/rescoreKit';
import { replayRescore } from './replayRescore';

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

  it('has no seconds per week when there is no week', async () => {
    const set = cases();
    set.weeks = [];

    const result = await replayRescore(set, deps(model()), false);

    expect(result).toMatchObject({ weeks: 0, mustIncludeRecall: null, secondsPerWeek: null });
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
