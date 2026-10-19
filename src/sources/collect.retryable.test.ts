import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectStep, type CollectDeps, type CollectInput, type CollectOutput } from './collect';
import { createGithubReleasesFetcher } from './adapters/githubReleases';
import { createRssFetcher } from './adapters/rss';
import type { Item, Source, SourceKind } from '../domain/schemas';
import type { SourceFetcher } from './SourceFetcher';
import { FetchError } from '../shared/errors';
import { fixedClock, noopLogger } from '../../test/fakes';

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

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('collectStep', () => {
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
});
