import { describe, expect, it } from 'vitest';
import { renderDigest } from '../../src/render/markdown';
import { makeDigest, makeItem, makeRunRecord } from '../../test/builders';
import { makeReplay } from '../replay/__fixtures__/replayKit';
import { hitsOf, idsOf, replayEndOf, sampleOf } from './replaySamples';
import { makeWeek, makeWeekRun } from './__fixtures__/scoringKit';

const items = [makeItem(), makeItem(), makeItem()];
const markdownOf = (linked: typeof items): string =>
  renderDigest(makeDigest(linked), { disabledGuards: [] });

describe('idsOf', () => {
  it('is the ids of the items the digest links to, in digest order', () => {
    const run = makeReplay({ items, markdown: markdownOf([items[2]!, items[0]!]) });

    expect(idsOf(run)).toEqual([items[2]!.id, items[0]!.id]);
  });

  it('is empty when the run wrote no digest', () => {
    expect(idsOf(makeReplay({ items, markdown: undefined }))).toEqual([]);
  });
});

describe('sampleOf', () => {
  it('carries the week, the digest and the items the replay served', () => {
    const markdown = markdownOf(items);

    const sample = sampleOf(makeReplay({ items, markdown }));

    expect(sample).toEqual({ weekId: '2026-W40', markdown, items });
  });

  it('says why a run wrote no digest', () => {
    const record = makeRunRecord({ status: 'quiet', dryRun: true });

    const sample = sampleOf(makeReplay({ markdown: undefined, record }));

    expect(sample.markdown).toBeUndefined();
    expect(sample.cause).toBe('run ended as "quiet"');
  });
});

describe('replayEndOf', () => {
  it('is how the run ended, its drafts and the output verdicts with their reasons', () => {
    const draft = { writer: 'gemma', passed: false, rejectedBy: ['clefRubric'] };
    const record = makeRunRecord({ status: 'blocked', drafts: [draft] });
    const run = makeReplay({
      record,
      outputVerdicts: [
        {
          draft: { writer: 'gemma', digest: makeDigest(items) },
          verdict: { check: 'clefRubric', flagged: true, reason: 'overclaims' },
        },
        {
          draft: { writer: 'gemma', digest: makeDigest(items) },
          verdict: { check: 'graniteGroundedness', flagged: false },
        },
      ],
    });

    expect(replayEndOf(run)).toEqual({
      label: '2026-W40',
      status: 'blocked',
      drafts: [draft],
      outputVerdicts: [
        { check: 'clefRubric', flagged: true, reason: 'overclaims' },
        { check: 'graniteGroundedness', flagged: false },
      ],
    });
  });
});

describe('hitsOf', () => {
  it('is the labels of the week, the ids its digest links to and the ids the replay served', () => {
    const week = makeWeek();
    const digestItems = week.items.slice(0, 2);
    const weekRun = makeWeekRun(week, { markdown: markdownOf(digestItems) });

    expect(hitsOf(weekRun)).toEqual({
      mustInclude: week.labels.mustInclude,
      mustExclude: week.labels.mustExclude,
      digestItemIds: digestItems.map((item) => item.id),
      visibleIds: weekRun.run.served,
    });
  });
});
