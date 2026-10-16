import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  collectStep,
  type CollectDeps,
  type CollectInput,
  type CollectOutput,
} from '../../../src/core/steps/collect.js';
import type { Item, Source, SourceKind } from '../../../src/core/schemas.js';
import type { FetchWindow, SourceFetcher } from '../../../src/ports/SourceFetcher.js';
import { makeItem } from '../../builders.js';
import { FakeSourceFetcher, fixedClock, noopLogger } from '../../fakes/index.js';

const SINCE = new Date('2026-10-05T00:00:00Z');
const UNTIL = new Date('2026-10-12T12:00:00Z');
const MAX_ITEMS = 10;

function makeSource(id: string, kind: SourceKind = 'rss', extra: Partial<Source> = {}): Source {
  return { id, kind, url: `https://example.com/${id}.xml`, ...extra };
}

function makeInput(
  sources: readonly Source[],
  overrides: Partial<CollectInput> = {},
): CollectInput {
  return { sources, since: SINCE, until: UNTIL, maxItemsPerSource: MAX_ITEMS, ...overrides };
}

function makeTestLogger() {
  const warn = vi.fn();
  const debug = vi.fn();
  return { logger: { ...noopLogger, warn, debug }, warn, debug };
}

function makeDeps(
  fetchers: CollectDeps['fetchers'],
  overrides: Partial<CollectDeps> = {},
): CollectDeps {
  return { fetchers, logger: noopLogger, clock: fixedClock(UNTIL), ...overrides };
}

/** Runs the step with fake timers so retry back-off and timeouts cost no real time. */
async function run(input: CollectInput, deps: CollectDeps): Promise<CollectOutput> {
  const pending = collectStep(input, deps);
  await vi.runAllTimersAsync();
  return pending;
}

function itemFor(sourceId: string, overrides: Partial<Item> = {}): Item {
  return makeItem({ sourceId, ...overrides });
}

function frozen<T extends object>(items: T[]): T[] {
  items.forEach((item) => Object.freeze(item));
  return Object.freeze(items) as T[];
}

/** Fetcher whose per-source result arrives after a delay; `finished` records completion order. */
function delayedFetcher(
  kind: SourceKind,
  plan: Readonly<Record<string, { delayMs: number; items: Item[] }>>,
  finished: string[] = [],
): SourceFetcher {
  return {
    kind,
    fetch: async (source) => {
      const entry = plan[source.id] ?? { delayMs: 0, items: [] };
      await new Promise<void>((resolve) => setTimeout(resolve, entry.delayMs));
      finished.push(source.id);
      return entry.items;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('collectStep', () => {
  it('collects from rss and github fetchers', async () => {
    const rssItem = itemFor('blog', { kind: 'rss' });
    const githubItem = itemFor('repo', { kind: 'github' });
    const rss = new FakeSourceFetcher('rss', { blog: [rssItem] });
    const github = new FakeSourceFetcher('github', { repo: [githubItem] });
    const input = makeInput([makeSource('blog', 'rss'), makeSource('repo', 'github')]);

    const out = await run(input, makeDeps({ rss, github }));

    expect(out.items).toHaveLength(2);
    expect(out.items).toEqual(expect.arrayContaining([rssItem, githubItem]));
    expect(out.failedSources).toEqual([]);
    expect(rss.calls.map((call) => call.source.id)).toEqual(['blog']);
    expect(github.calls.map((call) => call.source.id)).toEqual(['repo']);
  });

  it('passes the window and the per-source or default item cap to the fetcher', async () => {
    const rss = new FakeSourceFetcher('rss', {});
    const input = makeInput([makeSource('capped', 'rss', { maxItems: 3 }), makeSource('plain')]);

    await run(input, makeDeps({ rss }));

    const windows = new Map<string, FetchWindow>(
      rss.calls.map((call) => [call.source.id, call.window]),
    );
    expect(windows.get('capped')).toEqual({ since: SINCE, until: UNTIL, maxItems: 3 });
    expect(windows.get('plain')).toEqual({ since: SINCE, until: UNTIL, maxItems: MAX_ITEMS });
  });

  it('lists a failing source and keeps collecting from the others', async () => {
    const { logger, warn } = makeTestLogger();
    const good = itemFor('good');
    const rss = new FakeSourceFetcher('rss', {
      bad: new Error('HTTP 503 fetching bad'),
      good: [good],
    });
    const input = makeInput([makeSource('bad'), makeSource('good')]);

    const out = await run(input, makeDeps({ rss }, { logger, retries: 0 }));

    expect(out.items).toEqual([good]);
    expect(out.failedSources).toEqual([{ sourceId: 'bad', error: 'HTTP 503 fetching bad' }]);
    expect(warn).toHaveBeenCalledWith(
      'Source failed',
      expect.objectContaining({ sourceId: 'bad', error: 'HTTP 503 fetching bad' }),
    );
  });

  it('returns no items and every failure when all sources fail, without throwing', async () => {
    const rss = new FakeSourceFetcher('rss', { a: new Error('boom a'), b: new Error('boom b') });

    const out = await run(
      makeInput([makeSource('a'), makeSource('b')]),
      makeDeps({ rss }, { retries: 0 }),
    );

    expect(out).toEqual({
      items: [],
      failedSources: [
        { sourceId: 'a', error: 'boom a' },
        { sourceId: 'b', error: 'boom b' },
      ],
    });
  });

  it('reports a non-Error rejection by its string form', async () => {
    const fetcher: SourceFetcher = {
      kind: 'rss',
      // A misbehaving fetcher may reject with a non-Error; the step must still report it.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      fetch: () => Promise.reject('plain string'),
    };

    const out = await run(
      makeInput([makeSource('odd')]),
      makeDeps({ rss: fetcher }, { retries: 0 }),
    );

    expect(out.failedSources).toEqual([{ sourceId: 'odd', error: 'plain string' }]);
  });

  it('treats a synchronous throw from the fetcher as a failed source', async () => {
    const fetcher: SourceFetcher = {
      kind: 'rss',
      fetch: () => {
        throw new Error('sync boom');
      },
    };

    const out = await run(makeInput([makeSource('s')]), makeDeps({ rss: fetcher }, { retries: 0 }));

    expect(out.failedSources).toEqual([{ sourceId: 's', error: 'sync boom' }]);
  });

  it('treats a fetcher that returns a non-array as a failed source', async () => {
    const fetcher = { kind: 'rss', fetch: () => Promise.resolve(null) } as unknown as SourceFetcher;

    const out = await run(makeInput([makeSource('s')]), makeDeps({ rss: fetcher }, { retries: 0 }));

    expect(out.items).toEqual([]);
    expect(out.failedSources).toHaveLength(1);
    expect(out.failedSources[0]?.sourceId).toBe('s');
  });

  describe('timeout', () => {
    it('times out a hanging source, aborts its signal and lists it', async () => {
      const signals: AbortSignal[] = [];
      const hanging: SourceFetcher = {
        kind: 'rss',
        fetch: (_source, _window, signal) => {
          if (signal) signals.push(signal);
          return new Promise<Item[]>(() => undefined);
        },
      };
      const good = itemFor('good');
      const rss = new FakeSourceFetcher('rss', { good: [good] });
      const split: SourceFetcher = {
        kind: 'rss',
        fetch: (source, window, signal) =>
          source.id === 'hang' ? hanging.fetch(source, window, signal) : rss.fetch(source, window),
      };

      const out = await run(
        makeInput([makeSource('hang'), makeSource('good')]),
        makeDeps({ rss: split }, { timeoutMs: 50, retries: 0 }),
      );

      expect(out.items).toEqual([good]);
      expect(out.failedSources).toEqual([{ sourceId: 'hang', error: 'Timed out after 50 ms' }]);
      expect(signals).toHaveLength(1);
      expect(signals[0]?.aborted).toBe(true);
    });

    it('defaults to a 10 s timeout per attempt', async () => {
      const hanging: SourceFetcher = {
        kind: 'rss',
        fetch: () => new Promise<Item[]>(() => undefined),
      };

      const out = await run(
        makeInput([makeSource('hang')]),
        makeDeps({ rss: hanging }, { retries: 0 }),
      );

      expect(out.failedSources).toEqual([{ sourceId: 'hang', error: 'Timed out after 10000 ms' }]);
    });
  });

  describe('retry', () => {
    function flaky(
      failures: number,
      items: Item[],
    ): { fetcher: SourceFetcher; attempts: () => number } {
      let attempts = 0;
      const fetcher: SourceFetcher = {
        kind: 'rss',
        fetch: () => {
          attempts += 1;
          return attempts <= failures
            ? Promise.reject(new Error(`attempt ${attempts} failed`))
            : Promise.resolve(items);
        },
      };
      return { fetcher, attempts: () => attempts };
    }

    it('retries a source that fails twice and keeps its items', async () => {
      const kept = itemFor('flaky');
      const { fetcher, attempts } = flaky(2, [kept]);

      const out = await run(makeInput([makeSource('flaky')]), makeDeps({ rss: fetcher }));

      expect(out.items).toEqual([kept]);
      expect(out.failedSources).toEqual([]);
      expect(attempts()).toBe(3);
    });

    it('gives up after the configured retries and reports the last error', async () => {
      const { fetcher, attempts } = flaky(10, []);

      const out = await run(makeInput([makeSource('down')]), makeDeps({ rss: fetcher }));

      expect(attempts()).toBe(3);
      expect(out.failedSources).toEqual([{ sourceId: 'down', error: 'attempt 3 failed' }]);
    });

    it('honors deps.retries', async () => {
      const { fetcher, attempts } = flaky(10, []);

      await run(makeInput([makeSource('down')]), makeDeps({ rss: fetcher }, { retries: 1 }));

      expect(attempts()).toBe(2);
    });

    it('backs off 500 ms then 1000 ms between attempts', async () => {
      const { fetcher, attempts } = flaky(2, [itemFor('flaky')]);
      const pending = collectStep(makeInput([makeSource('flaky')]), makeDeps({ rss: fetcher }));

      await vi.advanceTimersByTimeAsync(0);
      expect(attempts()).toBe(1);
      await vi.advanceTimersByTimeAsync(499);
      expect(attempts()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(attempts()).toBe(2);
      await vi.advanceTimersByTimeAsync(999);
      expect(attempts()).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(attempts()).toBe(3);
      await expect(pending).resolves.toMatchObject({ failedSources: [] });
    });
  });

  describe('items', () => {
    it('dedupes the same item from two sources, keeping the first source in config order', async () => {
      const first = itemFor('first', { id: 'same', url: 'https://example.com/posts/same' });
      const second = itemFor('second', { id: 'same', url: 'https://example.com/posts/same' });
      const other = itemFor('second', { id: 'other' });
      const rss = new FakeSourceFetcher('rss', { first: [first], second: [second, other] });

      const out = await run(
        makeInput([makeSource('first'), makeSource('second')]),
        makeDeps({ rss }),
      );

      expect(out.items.map((item) => item.id).sort()).toEqual(['other', 'same']);
      expect(out.items.find((item) => item.id === 'same')?.sourceId).toBe('first');
    });

    it('keeps the config-order winner even when the later source answers first', async () => {
      const fast = itemFor('fast', { id: 'same' });
      const slow = itemFor('slow', { id: 'same' });
      const rss = delayedFetcher('rss', {
        slow: { delayMs: 500, items: [slow] },
        fast: { delayMs: 10, items: [fast] },
      });

      const out = await run(makeInput([makeSource('slow'), makeSource('fast')]), makeDeps({ rss }));

      expect(out.items).toEqual([slow]);
    });

    it('drops invalid items with a warning and keeps the valid ones', async () => {
      const { logger, warn } = makeTestLogger();
      const valid = itemFor('s1');
      const badUrl = { ...itemFor('s1'), url: 'not a url' };
      const badDate = { ...itemFor('s1'), publishedAt: 'yesterday' };
      const missingTitle = { ...itemFor('s1'), title: undefined } as unknown as Item;
      const rss = new FakeSourceFetcher('rss', { s1: [badUrl, valid, badDate, missingTitle] });

      const out = await run(makeInput([makeSource('s1')]), makeDeps({ rss }, { logger }));

      expect(out.items).toEqual([valid]);
      expect(out.failedSources).toEqual([]);
      const dropped = warn.mock.calls.filter(([message]) => message === 'Dropped invalid item');
      expect(dropped).toHaveLength(3);
      expect(dropped[0]?.[1]).toEqual(expect.objectContaining({ sourceId: 's1' }));
      // Untrusted item text must not leak into the log line.
      expect(JSON.stringify(dropped)).not.toMatch(/not a url|yesterday/);
    });

    it('drops items outside the window and keeps those exactly on its edges', async () => {
      const before = itemFor('s1', { publishedAt: '2026-10-04T23:59:59Z' });
      const atSince = itemFor('s1', { publishedAt: SINCE.toISOString() });
      const inside = itemFor('s1', { publishedAt: '2026-10-08T10:00:00Z' });
      const atUntil = itemFor('s1', { publishedAt: UNTIL.toISOString() });
      const after = itemFor('s1', { publishedAt: '2026-10-12T12:00:01Z' });
      const offset = itemFor('s1', { publishedAt: '2026-10-12T13:30:00+02:00' });
      const rss = new FakeSourceFetcher('rss', {
        s1: [before, atSince, inside, atUntil, after, offset],
      });

      const out = await run(makeInput([makeSource('s1')]), makeDeps({ rss }));

      expect(out.items).toHaveLength(4);
      expect(out.items).toEqual(expect.arrayContaining([atSince, inside, atUntil, offset]));
    });

    it('sorts newest first and keeps collection order for equal timestamps', async () => {
      const oldest = itemFor('a', { publishedAt: '2026-10-06T00:00:00Z' });
      const newest = itemFor('a', { publishedAt: '2026-10-11T00:00:00Z' });
      const tieA = itemFor('a', { publishedAt: '2026-10-09T00:00:00Z' });
      const tieB = itemFor('b', { publishedAt: '2026-10-09T00:00:00Z' });
      const rss = new FakeSourceFetcher('rss', { a: [oldest, tieA, newest], b: [tieB] });

      const out = await run(makeInput([makeSource('a'), makeSource('b')]), makeDeps({ rss }));

      expect(out.items).toEqual([newest, tieA, tieB, oldest]);
    });

    it('returns an empty result for no sources', async () => {
      const out = await run(makeInput([]), makeDeps({}));

      expect(out).toEqual({ items: [], failedSources: [] });
    });

    it('does not mutate the input or the fetcher results', async () => {
      const a = itemFor('a', { publishedAt: '2026-10-06T00:00:00Z' });
      const b = itemFor('a', { publishedAt: '2026-10-11T00:00:00Z' });
      const fetched = frozen([a, b]);
      const sources = frozen([makeSource('a')]);
      const rss: SourceFetcher = { kind: 'rss', fetch: () => Promise.resolve(fetched) };

      const out = await run(makeInput(sources), makeDeps({ rss }));

      expect(out.items).toEqual([b, a]);
      expect(out.items).not.toBe(fetched);
      expect(fetched).toEqual([a, b]);
    });
  });

  describe('missing fetcher', () => {
    it('lists a source whose kind has no fetcher and keeps the others', async () => {
      const { logger, warn } = makeTestLogger();
      const good = itemFor('blog');
      const rss = new FakeSourceFetcher('rss', { blog: [good] });
      const input = makeInput([makeSource('repo', 'github'), makeSource('blog', 'rss')]);

      const out = await run(input, makeDeps({ rss }, { logger }));

      expect(out.items).toEqual([good]);
      expect(out.failedSources).toHaveLength(1);
      expect(out.failedSources[0]?.sourceId).toBe('repo');
      expect(out.failedSources[0]?.error).toMatch(/no fetcher.*github/i);
      expect(warn).toHaveBeenCalledWith(
        'Source failed',
        expect.objectContaining({ sourceId: 'repo' }),
      );
    });

    it('does not retry or wait for a missing fetcher', async () => {
      const pending = collectStep(makeInput([makeSource('repo', 'github')]), makeDeps({}));

      await vi.advanceTimersByTimeAsync(0);

      await expect(pending).resolves.toMatchObject({ failedSources: [{ sourceId: 'repo' }] });
    });
  });

  describe('ordering and concurrency', () => {
    it('returns the same result whatever order the sources complete in', async () => {
      const finished: string[] = [];
      const s1 = itemFor('s1', { publishedAt: '2026-10-09T00:00:00Z' });
      const s2 = itemFor('s2', { publishedAt: '2026-10-09T00:00:00Z' });
      const s3 = itemFor('s3', { publishedAt: '2026-10-09T00:00:00Z' });
      const slowFirst = delayedFetcher(
        'rss',
        {
          s1: { delayMs: 300, items: [s1] },
          s2: { delayMs: 100, items: [s2] },
          s3: { delayMs: 200, items: [s3] },
        },
        finished,
      );
      const fastFirst = delayedFetcher('rss', {
        s1: { delayMs: 10, items: [s1] },
        s2: { delayMs: 20, items: [s2] },
        s3: { delayMs: 30, items: [s3] },
      });
      const input = makeInput([makeSource('s1'), makeSource('s2'), makeSource('s3')]);

      const a = await run(input, makeDeps({ rss: slowFirst }));
      const b = await run(input, makeDeps({ rss: fastFirst }));

      expect(finished).toEqual(['s2', 's3', 's1']);
      expect(a.items).toEqual([s1, s2, s3]);
      expect(b).toEqual(a);
    });

    it('lists failed sources in config order whatever order they fail in', async () => {
      const failing = (delayMs: number): SourceFetcher => ({
        kind: 'rss',
        fetch: async (source) => {
          await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
          throw new Error(`down ${source.id}`);
        },
      });
      const byId: Record<string, SourceFetcher> = {
        a: failing(300),
        b: failing(10),
        c: failing(100),
      };
      const rss: SourceFetcher = {
        kind: 'rss',
        fetch: (source, window, signal) => byId[source.id]!.fetch(source, window, signal),
      };

      const out = await run(
        makeInput([makeSource('a'), makeSource('b'), makeSource('c')]),
        makeDeps({ rss }, { retries: 0 }),
      );

      expect(out.failedSources.map((failure) => failure.sourceId)).toEqual(['a', 'b', 'c']);
    });

    it('runs at most four sources at a time', async () => {
      let active = 0;
      let peak = 0;
      const rss: SourceFetcher = {
        kind: 'rss',
        fetch: async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
          active -= 1;
          return [];
        },
      };
      const sources = Array.from({ length: 9 }, (_, index) => makeSource(`s${index}`));

      const out = await run(makeInput(sources), makeDeps({ rss }));

      expect(out.failedSources).toEqual([]);
      expect(peak).toBe(4);
    });

    it('keeps working through the queue when some sources fail', async () => {
      const rss = new FakeSourceFetcher('rss', {
        s0: new Error('x'),
        s1: new Error('x'),
        s2: [itemFor('s2')],
        s3: new Error('x'),
        s4: new Error('x'),
        s5: [itemFor('s5')],
        s6: [itemFor('s6')],
      });
      const sources = Array.from({ length: 7 }, (_, index) => makeSource(`s${index}`));

      const out = await run(makeInput(sources), makeDeps({ rss }, { retries: 0 }));

      expect(out.items.map((item) => item.sourceId).sort()).toEqual(['s2', 's5', 's6']);
      expect(out.failedSources.map((failure) => failure.sourceId)).toEqual([
        's0',
        's1',
        's3',
        's4',
      ]);
    });
  });
});
