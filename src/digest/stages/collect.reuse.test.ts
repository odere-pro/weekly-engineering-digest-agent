import { describe, expect, it } from 'vitest';
import { collect } from './collect';
import { FakeSourceFetcher } from '../../../test/fakes';
import { makeItem } from '../../../test/builders';
import { WEEK, contextFor, stateOf } from '../__fixtures__/stageKit';

const saved = [makeItem({ url: 'https://a.test/1', title: 'Saved' })];
const fresh = makeItem({ url: 'https://a.test/2', title: 'Fresh' });
const again = makeItem({ url: 'https://a.test/1?utm_source=x', title: 'Again' });

function run(reuse: { items: typeof saved; fetchSourceIds?: string[] }, found = [fresh, again]) {
  const fetcher = new FakeSourceFetcher('rss', { 'example-feed': found });
  const h = contextFor({ fetchers: { rss: fetcher }, reuse });
  return { fetcher, h, result: collect(h.ctx, stateOf(), h.logger) };
}

describe('collect with reuse', () => {
  it('fetches nothing for an empty source list and keeps the saved items', async () => {
    const { fetcher, result } = run({ items: saved, fetchSourceIds: [] });

    expect((await result).collected).toEqual(saved);
    expect(fetcher.calls).toHaveLength(0);
  });

  it('fetches the chosen sources only and merges, the saved item winning', async () => {
    const { fetcher, h, result } = run({ items: saved, fetchSourceIds: ['example-feed'] });

    const next = await result;

    expect(fetcher.calls).toHaveLength(1);
    expect(next.collected.map((item) => item.title)).toEqual(['Saved', 'Fresh']);
    expect(JSON.parse(h.store.artifacts.get(`${WEEK}/items.json`) ?? '[]')).toEqual(next.collected);
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        message: 'Reused saved items',
        fields: expect.objectContaining({ reused: 1, fetched: 2, merged: 2 }) as object,
      }),
    );
  });

  it('fetches every source when no ids are given', async () => {
    const { fetcher, result } = run({ items: saved });

    await result;

    expect(fetcher.calls).toHaveLength(1);
  });

  it('skips a source that is not among the ids', async () => {
    const { fetcher, result } = run({ items: saved, fetchSourceIds: ['other'] });

    await result;

    expect(fetcher.calls).toHaveLength(0);
  });

  it('settles as quiet when there is nothing saved and nothing new', async () => {
    const { result } = run({ items: [], fetchSourceIds: [] });

    expect((await result).settled).toMatchObject({ status: 'quiet' });
  });
});
