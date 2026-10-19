import { describe, expect, it, vi } from 'vitest';
import { collect } from './collect';
import { FakeSourceFetcher } from '../../../test/fakes';
import type { Item } from '../../domain/schemas';
import type { SourceFetcher } from '../../sources/SourceFetcher';
import { makeItem } from '../../../test/builders';
import { NOW, WEEK, contextFor, stateOf } from '../__fixtures__/stageKit';

const items = [1, 2, 3].map((n) =>
  makeItem({ id: `c${n}`, publishedAt: `2026-10-1${n}T09:00:00Z`, title: `Release ${n}` }),
);

describe('collect', () => {
  it('reads the sources over the window ending at the start of the run', async () => {
    const fetcher = new FakeSourceFetcher('rss', { 'example-feed': items });
    const h = contextFor({ fetchers: { rss: fetcher }, sinceDays: 3 });

    await collect(h.ctx, stateOf(), h.logger);

    expect(fetcher.calls).toHaveLength(1);
    expect(fetcher.calls[0]?.window).toMatchObject({
      since: new Date('2026-10-13T08:00:00Z'),
      until: new Date(NOW),
    });
  });

  it('keeps the items newest first, writes items.json and logs the count', async () => {
    const fetcher = new FakeSourceFetcher('rss', { 'example-feed': items });
    const h = contextFor({ fetchers: { rss: fetcher } });

    const next = await collect(h.ctx, stateOf(), h.logger);

    expect(next.collected.map((item) => item.id)).toEqual(['c3', 'c2', 'c1']);
    expect(next.failedSources).toEqual([]);
    expect(next.settled).toBeUndefined();
    expect(JSON.parse(h.store.artifacts.get(`${WEEK}/items.json`) ?? '[]')).toEqual(next.collected);
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        message: 'Collected items',
        fields: expect.objectContaining({ items: 3, failedSources: 0 }) as object,
      }),
    );
  });

  it('holds items.json when the earlier files of the week must stay', async () => {
    const fetcher = new FakeSourceFetcher('rss', { 'example-feed': items });
    const h = contextFor({ fetchers: { rss: fetcher }, holdArtifacts: true });

    const next = await collect(h.ctx, stateOf(), h.logger);

    expect(h.store.artifacts.size).toBe(0);
    expect(next.held.map((artifact) => artifact.name)).toEqual(['items.json']);
  });

  it('settles the run as quiet when no item was collected', async () => {
    const fetcher = new FakeSourceFetcher('rss', { 'example-feed': [] });
    const h = contextFor({ fetchers: { rss: fetcher } });

    const next = await collect(h.ctx, stateOf(), h.logger);

    expect(next.settled).toEqual({ status: 'quiet', note: 'no items collected' });
    expect(h.store.artifacts.get(`${WEEK}/items.json`)).toBe('[]\n');
  });

  it('names the failed sources in the state and in the note of a quiet week', async () => {
    const fetcher = new FakeSourceFetcher('rss', { 'example-feed': new Error('feed is down') });
    const h = contextFor({ fetchers: { rss: fetcher } });

    const next = await collect(h.ctx, stateOf(), h.logger);

    expect(next.failedSources).toEqual([{ sourceId: 'example-feed', error: 'feed is down' }]);
    expect(next.settled?.note).toBe('no items collected (1 of 1 sources failed)');
  });

  it('goes on with the items of the sources that worked when another failed', async () => {
    const fetcher = new FakeSourceFetcher('rss', { 'example-feed': items });
    const h = contextFor({
      fetchers: { rss: fetcher },
      config: {
        sources: [
          { id: 'example-feed', kind: 'rss', url: 'https://example.com/feed.xml' },
          { id: 'other-feed', kind: 'rss', url: 'https://example.org/feed.xml' },
        ],
      },
    });
    fetcher.fetch = (source, window) =>
      source.id === 'other-feed'
        ? Promise.reject(new Error('timeout'))
        : FakeSourceFetcher.prototype.fetch.call(fetcher, source, window);

    const next = await collect(h.ctx, stateOf(), h.logger);

    expect(next.collected).toHaveLength(3);
    expect(next.failedSources.map((failed) => failed.sourceId)).toEqual(['other-feed']);
    expect(next.settled).toBeUndefined();
  });
});

describe('collect when the run is told to stop', () => {
  /** Hangs until the signal it is given fires, as a real fetch does. */
  const hangingFetcher = (seen: AbortSignal[]): SourceFetcher => ({
    kind: 'rss',
    fetch: async (_source, _window, signal) => {
      if (signal) seen.push(signal);
      await new Promise<void>((resolve) => {
        signal?.addEventListener(
          'abort',
          () => {
            resolve();
          },
          { once: true },
        );
      });
      signal?.throwIfAborted();
      return [] as Item[];
    },
  });

  it('gives the fetchers a signal that fires with the run signal, and fails with its reason', async () => {
    const controller = new AbortController();
    const reason = new Error('run timed out');
    const seen: AbortSignal[] = [];
    const h = contextFor({ fetchers: { rss: hangingFetcher(seen) }, signal: controller.signal });
    const pending = collect(h.ctx, stateOf(), h.logger);
    await vi.waitFor(() => {
      expect(seen).toHaveLength(1);
    });

    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(seen[0]?.aborted).toBe(true);
  });

  it('starts no fetch when the signal fired already, and records no failed source', async () => {
    const controller = new AbortController();
    controller.abort(new Error('run timed out'));
    const fetcher = new FakeSourceFetcher('rss', { 'example-feed': items });
    const h = contextFor({ fetchers: { rss: fetcher }, signal: controller.signal });

    await expect(collect(h.ctx, stateOf(), h.logger)).rejects.toThrow('run timed out');

    expect(fetcher.calls).toEqual([]);
    expect(h.store.artifacts.size).toBe(0);
  });
});
