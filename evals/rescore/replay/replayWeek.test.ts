import { describe, expect, it } from 'vitest';
import type { ScoredItem } from '../../../src/classify/classification';
import type { Calibration } from '../../../src/process/calibration';
import { makeClassification, makeItem } from '../../../test/builders';
import { FakeModelProvider } from '../../../test/fakes';
import { cases, deps, items, model, tickingClock } from '../__fixtures__/rescoreKit';
import { replayWeek, selectTop } from './replayWeek';

const scoredItem = (id: string, relevance: number): ScoredItem => ({
  ...makeItem({ id, title: `Item ${id}` }),
  classification: makeClassification(id, { relevance }),
});

describe('selectTop', () => {
  it('picks the five best by relevance', async () => {
    const scored = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, i) => scoredItem(id, 1.5 + i / 10));

    const { selected } = await selectTop(scored, deps(model()));

    expect(selected.map((item) => item.id)).toEqual(['f', 'e', 'd', 'c', 'b']);
  });

  it('applies the calibration', async () => {
    const calibration: Calibration = {
      version: 1,
      profile: 'light',
      points: [{ raw: 1.5, calibrated: 0 }],
      areaBias: {},
    };

    const { selected } = await selectTop([scoredItem('a', 3)], { ...deps(model()), calibration });

    expect(selected).toEqual([]);
  });

  it('asks the model nothing without the pairwise flag', async () => {
    const fake = model();

    await selectTop([scoredItem('a', 3), scoredItem('b', 3)], deps(fake));

    expect(fake.decideCalls).toHaveLength(0);
  });

  it('with pairwise on orders the survivors by the judge games', async () => {
    const fake = new FakeModelProvider({
      // The judge always prefers the item whose title is alphabetically later.
      decide: (request) => {
        const titles = [...request.state.matchAll(/Title: Item (\w)/g)].map((m) => m[1] ?? '');
        return {
          prefer: { type: 'yesno', probability: (titles[0] ?? '') > (titles[1] ?? '') ? 1 : 0 },
        };
      },
    });
    const scored = ['a', 'b', 'c'].map((id) => scoredItem(id, 2.5));

    const off = await selectTop(scored, deps(fake));
    const on = await selectTop(scored, { ...deps(fake), pairwise: true });

    // All three score 2.5, so the plain order keeps the input order. The tournament is short
    // (two rounds for three items): it puts the item that lost every game, a, last.
    expect(off.selected.map((item) => item.id)).toEqual(['a', 'b', 'c']);
    expect(on.selected.map((item) => item.id)).toEqual(['b', 'c', 'a']);
    expect(fake.decideCalls.length).toBeGreaterThan(0);
  });
});

describe('replayWeek', () => {
  it('returns the labels, the picked ids, the served ids and the seconds', async () => {
    const [week] = cases().weeks;

    const { hits, seconds } = await replayWeek(
      week!,
      { ...deps(model()), clock: tickingClock() },
      false,
    );

    expect(hits.mustInclude).toEqual(['a', 'b']);
    expect(hits.mustExclude).toEqual(['c']);
    expect(hits.digestItemIds).toHaveLength(5);
    expect(hits.visibleIds).toEqual(new Set(items.map((item) => item.id)));
    // The ticking clock moves 2 s per reading and the week reads it twice.
    expect(seconds).toBe(2);
  });

  it('cannot report a negative time when the clock runs backwards', async () => {
    const [week] = cases().weeks;
    const readings = [Date.parse('2026-10-12T00:00:10Z'), Date.parse('2026-10-12T00:00:00Z')];
    const clock = { now: () => new Date(readings.shift() ?? 0) };

    const { seconds } = await replayWeek(week!, { ...deps(model()), clock }, false);

    expect(seconds).toBe(0);
  });

  it('classifies one item at a time with the decider', async () => {
    const fake = model();
    const [week] = cases().weeks;

    await replayWeek(week!, deps(fake), false);

    expect(fake.decideCalls).toHaveLength(week!.items.length);
  });
});
