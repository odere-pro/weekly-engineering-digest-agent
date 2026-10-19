import { describe, expect, it } from 'vitest';
import { processItems } from './processItems';
import { makeRunRecord } from '../../../test/builders';
import { WEEK, contextFor, scored, stateOf } from '../__fixtures__/stageKit';

const AREAS = ['AI models and tooling', 'Platform engineering'];
const withArea = (relevance: number, index: number) =>
  scored(relevance, { title: `Release ${index}` });

describe('processItems', () => {
  it('selects the top N by relevance and counts what passed the filters before the cut', async () => {
    const h = contextFor({ config: { topN: 3, focusAreas: AREAS } });
    const items = [3, 2.9, 2.8, 2.7, 2.6].map(withArea);

    const next = await processItems(h.ctx, stateOf({ scored: items }), h.logger);

    expect(next.selected).toHaveLength(3);
    expect(next.afterProcess).toBe(5);
    expect(next.settled).toBeUndefined();
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        message: 'Selected items',
        fields: expect.objectContaining({ selected: 3, dropped: 2 }) as object,
      }),
    );
  });

  it('leaves the items under the relevance floor out of afterProcess', async () => {
    const h = contextFor({ config: { topN: 3, thresholds: { minRelevance: 2 } } });
    const items = [3, 2.5, 2.2, 2.1, 1].map(withArea);

    const next = await processItems(h.ctx, stateOf({ scored: items }), h.logger);

    expect(next.afterProcess).toBe(4);
    expect(next.selected).toHaveLength(3);
  });

  it('drops an item an earlier week sent', async () => {
    const h = contextFor({ config: { topN: 3 } });
    const items = [3, 2.9, 2.8, 2.7].map(withArea);
    h.store.records.set(
      '2026-W41',
      makeRunRecord({ runId: '2026-W41', status: 'sent', sentUrls: [items[0]!.url] }),
    );

    const next = await processItems(h.ctx, stateOf({ scored: items }), h.logger);

    expect(next.selected.map((item) => item.id)).not.toContain(items[0]!.id);
    expect(next.afterProcess).toBe(3);
  });

  it('does not count the week it is running against in the dedupe', async () => {
    const h = contextFor({ config: { topN: 3 } });
    const items = [3, 2.9, 2.8].map(withArea);
    h.store.records.set(
      WEEK,
      makeRunRecord({ runId: WEEK, status: 'sent', sentUrls: [items[0]!.url] }),
    );

    const next = await processItems(h.ctx, stateOf({ scored: items }), h.logger);

    expect(next.selected).toHaveLength(3);
  });

  it('settles the run as quiet, with no note, when fewer than 3 items are left', async () => {
    const h = contextFor({ config: { topN: 3 } });
    const items = [3, 2.9, 0.5].map(withArea);

    const next = await processItems(h.ctx, stateOf({ scored: items }), h.logger);

    expect(next.settled).toEqual({ status: 'quiet' });
    expect(next.selected).toHaveLength(2);
    expect(next.afterProcess).toBe(2);
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        message: 'Quiet week: too few items for a digest',
        fields: expect.objectContaining({ needed: 3 }) as object,
      }),
    );
  });
});
