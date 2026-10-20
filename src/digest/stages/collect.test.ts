import { describe, expect, it, vi } from 'vitest';
import { collect } from './collect';
import { FakeSourceFetcher } from '../../../test/fakes';
import type { Item } from '../../domain/schemas';
import { DigestError } from '../../shared/errors';
import type { SourceFetcher } from '../../sources/SourceFetcher';
import { makeItem } from '../../../test/builders';
import { PartialFailure } from '../chain/failures';
import { isUnretriable } from '../ending/notes/unretriable';
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

  describe('when some sources failed and the others returned nothing', () => {
    const twoFeeds = {
      sources: [
        { id: 'example-feed', kind: 'rss' as const, url: 'https://example.com/feed.xml' },
        { id: 'other-feed', kind: 'rss' as const, url: 'https://example.org/feed.xml' },
      ],
    };

    it('stays quiet, with the failed sources in the state and the counts in the note', async () => {
      const fetcher = new FakeSourceFetcher('rss', {
        'example-feed': [],
        'other-feed': new Error('feed is down'),
      });
      const h = contextFor({ fetchers: { rss: fetcher }, config: twoFeeds });

      const next = await collect(h.ctx, stateOf(), h.logger);

      expect(next.failedSources).toEqual([{ sourceId: 'other-feed', error: 'feed is down' }]);
      expect(next.settled).toEqual({
        status: 'quiet',
        note: 'no items collected (1 of 2 sources failed)',
      });
    });
  });

  describe('when every source failed', () => {
    const everySourceFails = (): ReturnType<typeof contextFor> =>
      contextFor({
        fetchers: {
          rss: new FakeSourceFetcher('rss', {
            'example-feed': new Error('getaddrinfo ENOTFOUND feed.example.com'),
            'other-feed': new Error('getaddrinfo ENOTFOUND other.example.org'),
          }),
        },
        config: {
          sources: [
            { id: 'example-feed', kind: 'rss', url: 'https://feed.example.com/feed.xml' },
            { id: 'other-feed', kind: 'rss', url: 'https://other.example.org/feed.xml' },
          ],
        },
      });

    it('fails the collect step instead of settling the week as quiet', async () => {
      const h = everySourceFails();

      const failure = await collect(h.ctx, stateOf(), h.logger).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(PartialFailure);
      const { state, cause } = failure as PartialFailure;
      expect(cause).toBeInstanceOf(DigestError);
      expect(cause).toMatchObject({ step: 'collect' });
      expect(state.settled).toBeUndefined();
      expect(state.failedSources.map((failed) => failed.sourceId)).toEqual([
        'example-feed',
        'other-feed',
      ]);
    });

    it('names the counts only, never a feed address or the text a feed returned', async () => {
      const h = everySourceFails();

      const failure = await collect(h.ctx, stateOf(), h.logger).catch((error: unknown) => error);

      const { message } = (failure as PartialFailure).cause as DigestError;
      expect(message).toBe('every source failed (2 of 2 sources), so no items were collected');
      expect(message).not.toMatch(/example\.(com|org)|ENOTFOUND/);
    });

    it('is not a failure that no retry can clear', async () => {
      const h = everySourceFails();

      const failure = await collect(h.ctx, stateOf(), h.logger).catch((error: unknown) => error);

      const { message } = (failure as PartialFailure).cause as DigestError;
      expect(isUnretriable(message)).toBe(false);
    });
  });

  it('settles the run as quiet when no source is configured: nothing failed', async () => {
    // The config schema asks for a source, so build the context the schema would refuse.
    const h = contextFor({ fetchers: {} });
    const ctx = {
      ...h.ctx,
      deps: { ...h.ctx.deps, config: { ...h.ctx.deps.config, sources: [] } },
    };

    const next = await collect(ctx, stateOf(), h.logger);

    expect(next.settled).toEqual({ status: 'quiet', note: 'no items collected' });
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
