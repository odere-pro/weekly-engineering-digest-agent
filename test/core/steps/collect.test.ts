import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  collectStep,
  type CollectDeps,
  type CollectInput,
  type CollectOutput,
} from '../../../src/core/steps/collect.js';
import { createGithubReleasesFetcher } from '../../../src/adapters/sources/githubReleases.js';
import { createRssFetcher } from '../../../src/adapters/sources/rss.js';
import type { Item, Source, SourceKind } from '../../../src/core/schemas.js';
import type { FetchWindow, SourceFetcher } from '../../../src/ports/SourceFetcher.js';
import { FetchError } from '../../../src/shared/errors.js';
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

/** An HTTP answer as the fetchers report it: the status and whether another try can help. */
function httpFailure(status: number, retryable: boolean, label = 's'): FetchError {
  return new FetchError(`HTTP ${status} fetching ${label}`, { status, retryable });
}

/** A failure no retry can fix. */
function permanentFailure(message: string, cause?: unknown): FetchError {
  return new FetchError(message, { retryable: false, cause });
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
      bad: httpFailure(503, true, 'bad'),
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
            ? Promise.reject(
                new FetchError(`HTTP 503 fetching flaky (attempt ${attempts})`, {
                  status: 503,
                  retryable: true,
                }),
              )
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
      expect(out.failedSources).toEqual([
        { sourceId: 'down', error: 'HTTP 503 fetching flaky (attempt 3)' },
      ]);
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

  describe('which errors are retried', () => {
    /** A fetcher that always rejects with `error` and counts its attempts. */
    function alwaysFailing(error: Error): { fetcher: SourceFetcher; attempts: () => number } {
      let attempts = 0;
      const fetcher: SourceFetcher = {
        kind: 'rss',
        fetch: () => {
          attempts += 1;
          return Promise.reject(error);
        },
      };
      return { fetcher, attempts: () => attempts };
    }

    async function attemptsFor(error: Error): Promise<number> {
      const { fetcher, attempts } = alwaysFailing(error);
      await run(makeInput([makeSource('s')]), makeDeps({ rss: fetcher }));
      return attempts();
    }

    const networkCause = (code: string): Error =>
      Object.assign(new Error(`low level ${code}`), { code });
    const redactedFetchFailure = (): Error => {
      // The GitHub fetcher rebuilds a failure from its message and name alone.
      const safe = new Error('fetch failed');
      safe.name = 'TypeError';
      return safe;
    };

    it.each([
      ['a 400', httpFailure(400, false)],
      ['a 404', httpFailure(404, false)],
      ['a 410', httpFailure(410, false)],
      ['a 403', httpFailure(403, false)],
      [
        'a GitHub rate limit (403)',
        new FetchError('GitHub rate limit hit fetching s (HTTP 403)', {
          status: 403,
          retryable: false,
        }),
      ],
      [
        'a GitHub rate limit (429) with a reset time',
        new FetchError(
          'GitHub rate limit hit fetching s (HTTP 429); resets at 2026-10-12T10:00:00.000Z',
          { status: 429, retryable: false },
        ),
      ],
      ['a feed parse error', permanentFailure('Cannot parse feed s: Unexpected close tag')],
      [
        'a bad GitHub URL',
        permanentFailure(
          'Source s is not a GitHub repository URL (expected https://github.com/<owner>/<repo>)',
        ),
      ],
      ['a malformed GitHub response', permanentFailure('Malformed GitHub API response fetching s')],
      [
        'a refused redirect',
        permanentFailure('s redirected to evil.example.org, which is not its own host'),
      ],
      ['a missing fetcher result', new Error('Fetcher did not return a list of items')],
      ['a programming error', new TypeError("Cannot read properties of undefined (reading 'x')")],
      // The typed answer decides; nothing else about the error is consulted.
      [
        'a FetchError that says no, whose cause is a reset connection',
        permanentFailure('gave up', networkCause('ECONNRESET')),
      ],
      ['a FetchError that says no, worded "fetch failed"', permanentFailure('fetch failed')],
      ['an HTTP 503 message on a plain Error', new Error('HTTP 503 fetching s')],
      ['an HTTP 500 message on a plain Error', new Error('HTTP 500 fetching s')],
    ])('tries %s once and gives up', async (_name, error) => {
      expect(await attemptsFor(error)).toBe(1);
    });

    it.each([
      ['a 408', httpFailure(408, true)],
      ['a 429', httpFailure(429, true)],
      ['a 500', httpFailure(500, true)],
      ['a 503', httpFailure(503, true)],
      ['a 599', httpFailure(599, true)],
      [
        'a FetchError that says yes, without a status',
        new FetchError('hiccup', { retryable: true }),
      ],
      [
        'a FetchError that says yes, whatever its message',
        new FetchError('totally unrelated text', { retryable: true }),
      ],
      [
        'a refused connection',
        new TypeError('fetch failed', { cause: networkCause('ECONNREFUSED') }),
      ],
      ['a reset connection', new TypeError('fetch failed', { cause: networkCause('ECONNRESET') })],
      ['a DNS failure', new TypeError('fetch failed', { cause: networkCause('ENOTFOUND') })],
      ['a dropped body', new TypeError('terminated', { cause: networkCause('UND_ERR_SOCKET') })],
      ['a coded error without a cause', networkCause('ETIMEDOUT')],
      ['a fetch failure with its cause stripped', redactedFetchFailure()],
    ])('retries %s twice', async (_name, error) => {
      expect(await attemptsFor(error)).toBe(3);
    });

    it('retries a source that times out', async () => {
      let attempts = 0;
      const hanging: SourceFetcher = {
        kind: 'rss',
        fetch: () => {
          attempts += 1;
          return new Promise<Item[]>(() => undefined);
        },
      };

      const out = await run(
        makeInput([makeSource('hang')]),
        makeDeps({ rss: hanging }, { timeoutMs: 50 }),
      );

      expect(attempts).toBe(3);
      expect(out.failedSources).toEqual([{ sourceId: 'hang', error: 'Timed out after 50 ms' }]);
    });

    it('stops retrying as soon as the error stops being retryable', async () => {
      const errors = [httpFailure(503, true), httpFailure(404, false)];
      let attempts = 0;
      const fetcher: SourceFetcher = {
        kind: 'rss',
        fetch: () => Promise.reject(errors[attempts++] ?? new Error('unexpected extra attempt')),
      };

      const out = await run(makeInput([makeSource('s')]), makeDeps({ rss: fetcher }));

      expect(attempts).toBe(2);
      expect(out.failedSources).toEqual([{ sourceId: 's', error: 'HTTP 404 fetching s' }]);
    });

    it('does not log a retry for an error it gives up on at once', async () => {
      const { logger, debug } = makeTestLogger();
      const { fetcher } = alwaysFailing(httpFailure(404, false));

      await run(makeInput([makeSource('s')]), makeDeps({ rss: fetcher }, { logger }));

      expect(debug).not.toHaveBeenCalledWith('Retrying source', expect.anything());
    });
  });

  // The step trusts the `retryable` flag of the fetchers' FetchErrors, so pin it to the real ones.
  describe('which errors are retried, with the real fetchers', () => {
    const replying = (status: number, headers: Record<string, string> = {}) =>
      vi.fn<typeof fetch>(() => Promise.resolve(new Response('not a feed', { status, headers })));
    const github = (id: string): Source => ({
      id,
      kind: 'github',
      url: 'https://github.com/acme/tool',
    });

    async function fetchCalls(
      source: Source,
      fetchFn: ReturnType<typeof vi.fn<typeof fetch>>,
    ): Promise<{ calls: number; failure: string | undefined }> {
      const fetchers = {
        rss: createRssFetcher({ fetch: fetchFn }),
        github: createGithubReleasesFetcher({ fetch: fetchFn }),
      };
      const out = await run(makeInput([source]), makeDeps(fetchers));
      return { calls: fetchFn.mock.calls.length, failure: out.failedSources[0]?.error };
    }

    it.each([
      [500, 3],
      [503, 3],
      [408, 3],
      [429, 3],
      [404, 1],
      [403, 1],
    ])('rss: an HTTP %i answer is fetched %i time(s)', async (status, calls) => {
      expect((await fetchCalls(makeSource('feed'), replying(status))).calls).toBe(calls);
    });

    it.each([
      [503, {}, 3],
      [429, {}, 3],
      [404, {}, 1],
      [403, { 'x-ratelimit-remaining': '0' }, 1],
      [429, { 'retry-after': '60' }, 1],
    ])('github: an HTTP %i answer %j is fetched %i time(s)', async (status, headers, calls) => {
      const result = await fetchCalls(github('repo'), replying(status, headers));

      expect(result.calls).toBe(calls);
      expect(result.failure).toContain(`HTTP ${status}`);
    });

    it('rss: retries a dropped connection', async () => {
      const cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
      const dropped = vi.fn<typeof fetch>(() =>
        Promise.reject(new TypeError('fetch failed', { cause })),
      );

      expect((await fetchCalls(makeSource('feed'), dropped)).calls).toBe(3);
    });

    it('rss: a 200 answer that does not parse is fetched once', async () => {
      const result = await fetchCalls(makeSource('feed'), replying(200));

      expect(result.calls).toBe(1);
      expect(result.failure).toContain('Cannot parse feed feed');
    });

    it('github: a URL that is not a repository is never fetched', async () => {
      const fetchFn = replying(200);
      const bad: Source = { id: 'repo', kind: 'github', url: 'https://example.com/acme/tool' };

      const result = await fetchCalls(bad, fetchFn);

      expect(result.calls).toBe(0);
      expect(result.failure).toContain('not a GitHub repository URL');
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

  describe('a source that returns nothing usable', () => {
    const NOTHING_USABLE = 'Source returned no usable items';

    it('warns, without listing the source as failed', async () => {
      const { logger, warn } = makeTestLogger();
      const rss = new FakeSourceFetcher('rss', { quiet: [] });

      const out = await run(makeInput([makeSource('quiet')]), makeDeps({ rss }, { logger }));

      expect(out).toEqual({ items: [], failedSources: [] });
      expect(warn).toHaveBeenCalledWith(NOTHING_USABLE, { sourceId: 'quiet', fetched: 0 });
    });

    it('warns when everything the fetcher returned was dropped', async () => {
      const { logger, warn } = makeTestLogger();
      const tooOld = itemFor('stale', { publishedAt: '2026-09-01T00:00:00Z' });
      const rss = new FakeSourceFetcher('rss', { stale: [tooOld] });

      await run(makeInput([makeSource('stale')]), makeDeps({ rss }, { logger }));

      expect(warn).toHaveBeenCalledWith(NOTHING_USABLE, { sourceId: 'stale', fetched: 1 });
    });

    it('names each quiet source once and stays silent for the others', async () => {
      const { logger, warn } = makeTestLogger();
      const rss = new FakeSourceFetcher('rss', { quiet: [], busy: [itemFor('busy')] });

      await run(
        makeInput([makeSource('quiet'), makeSource('busy')]),
        makeDeps({ rss }, { logger }),
      );

      const quiet = warn.mock.calls.filter(([message]) => message === NOTHING_USABLE);
      expect(quiet).toEqual([[NOTHING_USABLE, { sourceId: 'quiet', fetched: 0 }]]);
    });

    it('does not add this warning to a source that failed', async () => {
      const { logger, warn } = makeTestLogger();
      const rss = new FakeSourceFetcher('rss', { down: permanentFailure('boom') });

      await run(makeInput([makeSource('down')]), makeDeps({ rss }, { logger }));

      expect(warn.mock.calls.map((call: unknown[]) => call[0])).toEqual(['Source failed']);
    });
  });

  describe('error text', () => {
    it('caps what a long fetcher error adds to failedSources', async () => {
      const rss = new FakeSourceFetcher('rss', {
        s: new Error(`Cannot parse ${'word '.repeat(200)}`),
      });

      const out = await run(makeInput([makeSource('s')]), makeDeps({ rss }));

      const message = out.failedSources[0]?.error ?? '';
      expect(message.length).toBeLessThanOrEqual(300);
      expect(message.length).toBeGreaterThan(250);
      expect(message.startsWith('Cannot parse word word')).toBe(true);
      expect(message.endsWith('...')).toBe(true);
    });

    it('caps the logged text the same way', async () => {
      const { logger, warn } = makeTestLogger();
      const rss = new FakeSourceFetcher('rss', { s: new Error('x'.repeat(5000)) });

      await run(makeInput([makeSource('s')]), makeDeps({ rss }, { logger }));

      const fields = warn.mock.calls.find(([message]) => message === 'Source failed')?.[1] as
        { error: string } | undefined;
      expect(fields?.error.length).toBeLessThanOrEqual(300);
    });

    it('caps the text of the retry line too', async () => {
      const { logger, debug } = makeTestLogger();
      const rss = new FakeSourceFetcher('rss', {
        s: new FetchError('y'.repeat(5000), { retryable: true }),
      });

      await run(makeInput([makeSource('s')]), makeDeps({ rss }, { logger }));

      const retries = debug.mock.calls.filter(([message]) => message === 'Retrying source');
      expect(retries).toHaveLength(2);
      for (const [, fields] of retries) {
        expect((fields as { error: string }).error.length).toBeLessThanOrEqual(300);
      }
    });

    it('leaves a message of exactly 300 characters alone', async () => {
      const message = 'e'.repeat(300);
      const rss = new FakeSourceFetcher('rss', { s: new Error(message) });

      const out = await run(makeInput([makeSource('s')]), makeDeps({ rss }));

      expect(out.failedSources).toEqual([{ sourceId: 's', error: message }]);
    });
  });

  describe('item cap', () => {
    const day = (n: number): string => `2026-10-${String(n).padStart(2, '0')}T09:00:00Z`;
    const sorted = (items: Item[]): string[] => items.map((item) => item.id);

    it('keeps only the newest items when a fetcher returns more than the source cap', async () => {
      const items = [6, 11, 8, 10, 7].map((n) =>
        itemFor('s', { id: `day-${n}`, publishedAt: day(n) }),
      );
      const rss = new FakeSourceFetcher('rss', { s: items });

      const out = await run(
        makeInput([makeSource('s', 'rss', { maxItems: 2 })]),
        makeDeps({ rss }),
      );

      expect(sorted(out.items)).toEqual(['day-11', 'day-10']);
    });

    it('uses the default cap for a source without its own', async () => {
      const items = [6, 7, 8, 9, 10].map((n) =>
        itemFor('s', { id: `day-${n}`, publishedAt: day(n) }),
      );
      const rss = new FakeSourceFetcher('rss', { s: items });

      const out = await run(
        makeInput([makeSource('s')], { maxItemsPerSource: 3 }),
        makeDeps({ rss }),
      );

      expect(sorted(out.items)).toEqual(['day-10', 'day-9', 'day-8']);
    });

    it('caps each source on its own', async () => {
      const a = [6, 7, 8].map((n) => itemFor('a', { id: `a-${n}`, publishedAt: day(n) }));
      const b = [9, 10, 11].map((n) => itemFor('b', { id: `b-${n}`, publishedAt: day(n) }));
      const rss = new FakeSourceFetcher('rss', { a, b });

      const out = await run(
        makeInput([makeSource('a'), makeSource('b')], { maxItemsPerSource: 2 }),
        makeDeps({ rss }),
      );

      expect(sorted(out.items)).toEqual(['b-11', 'b-10', 'a-8', 'a-7']);
    });

    it('dedupes before capping, so a duplicate of an earlier source does not use up a slot', async () => {
      const shared = itemFor('first', { id: 'shared', publishedAt: day(11) });
      const duplicate = itemFor('second', { id: 'shared', publishedAt: day(11) });
      const mine = itemFor('second', { id: 'mine', publishedAt: day(10) });
      const older = itemFor('second', { id: 'older', publishedAt: day(9) });
      const rss = new FakeSourceFetcher('rss', {
        first: [shared],
        second: [duplicate, mine, older],
      });

      const out = await run(
        makeInput([makeSource('first'), makeSource('second')], { maxItemsPerSource: 2 }),
        makeDeps({ rss }),
      );

      expect(sorted(out.items)).toEqual(['shared', 'mine', 'older']);
    });

    it('counts an item a source lists twice once', async () => {
      const once = itemFor('s', { id: 'twice', publishedAt: day(11) });
      const again = itemFor('s', { id: 'twice', publishedAt: day(11) });
      const other = itemFor('s', { id: 'other', publishedAt: day(10) });
      const rss = new FakeSourceFetcher('rss', { s: [once, again, other] });

      const out = await run(
        makeInput([makeSource('s')], { maxItemsPerSource: 2 }),
        makeDeps({ rss }),
      );

      expect(sorted(out.items)).toEqual(['twice', 'other']);
    });

    it('does not let a capped-off item block the same item from a later source', async () => {
      const keep = itemFor('first', { id: 'keep', publishedAt: day(11) });
      const cutOff = itemFor('first', { id: 'cut', publishedAt: day(7) });
      const sameAsCutOff = itemFor('second', { id: 'cut', publishedAt: day(7) });
      const rss = new FakeSourceFetcher('rss', { first: [keep, cutOff], second: [sameAsCutOff] });

      const out = await run(
        makeInput([makeSource('first', 'rss', { maxItems: 1 }), makeSource('second')]),
        makeDeps({ rss }),
      );

      expect(sorted(out.items)).toEqual(['keep', 'cut']);
      expect(out.items.find((item) => item.id === 'cut')?.sourceId).toBe('second');
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
