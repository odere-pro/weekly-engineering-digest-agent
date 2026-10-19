import { describe, expect, it, vi } from 'vitest';
import type { Source, SourceKind } from '../../../domain/schemas';
import type { SourceFetcher } from '../../../sources/SourceFetcher';
import { fixedClock } from '../../../../test/fakes';
import {
  ATOM_FEED,
  FEED_URL,
  GITHUB_URL,
  resultFor,
  runDoctor,
  urlOf,
} from '../__fixtures__/doctorHarness';
import { checkSource, SOURCE_TIMEOUT_MS } from './sources';

describe('checkSource', () => {
  const source: Source = { id: 'example-feed', kind: 'rss', url: FEED_URL };
  const io = { clock: fixedClock('2026-10-16T09:00:00Z'), sourceTimeoutMs: 50 };

  function fetchers(fetchOne: SourceFetcher['fetch']): Record<SourceKind, SourceFetcher> {
    return { rss: { kind: 'rss', fetch: fetchOne }, github: { kind: 'github', fetch: vi.fn() } };
  }

  it('reads one item through the fetcher of the source kind, from one day before now', async () => {
    const fetchOne = vi.fn<SourceFetcher['fetch']>(async () => []);

    const result = await checkSource(source, fetchers(fetchOne), io);

    expect(result).toEqual({
      severity: 'ok',
      label: 'source example-feed',
      message: 'reachable and readable',
    });
    const [, window] = fetchOne.mock.calls[0] ?? [];
    expect(window?.until.toISOString()).toBe('2026-10-16T09:00:00.000Z');
    expect(window?.since.toISOString()).toBe('2026-10-15T09:00:00.000Z');
    expect(window?.maxItems).toBe(1);
  });

  it('warns with the error message, and a fix that says a run skips the source', async () => {
    const result = await checkSource(
      source,
      fetchers(async () => {
        throw new Error('HTTP 404');
      }),
      io,
    );

    expect(result).toMatchObject({
      severity: 'warn',
      label: 'source example-feed',
      message: 'HTTP 404',
    });
    expect(result.fix).toContain('a run skips it');
  });

  it('warns when the fetcher does not answer within the timeout', async () => {
    const result = await checkSource(
      source,
      fetchers(() => new Promise(() => undefined)),
      io,
    );

    expect(result.severity).toBe('warn');
    expect(result.message).toMatch(/timed out/i);
  });

  it('stops a slow fetcher through the abort signal', async () => {
    let signal: AbortSignal | undefined;

    await checkSource(
      source,
      fetchers((_source, _window, given) => {
        signal = given;
        return new Promise(() => undefined);
      }),
      io,
    );

    expect(signal?.aborted).toBe(true);
  });
});

describe('SOURCE_TIMEOUT_MS', () => {
  it('is 10 seconds', () => {
    expect(SOURCE_TIMEOUT_MS).toBe(10_000);
  });
});

describe('doctor source checks', () => {
  it('reads every source through the real fetchers with a one-day window', async () => {
    const { h } = await runDoctor({
      config: {
        sources: [
          { id: 'example-feed', kind: 'rss', url: FEED_URL },
          { id: 'acme-tool', kind: 'github', url: GITHUB_URL },
        ],
      },
    });

    const urls = h.fetch.mock.calls.map(([input]) => String(input));
    expect(urls).toEqual([FEED_URL, `${GITHUB_URL}/releases.atom`]);
  });

  it('prints ! naming the source for an HTTP failure and still returns 0', async () => {
    const { code, text } = await runDoctor({
      fetch: async () => new Response('gone', { status: 404 }),
    });

    expect(code).toBe(0);
    expect(resultFor(text, '!', 'source example-feed:')).toMatch(
      /404.*\n\s+fix: .*(feed|source).*digest\.config\.json/i,
    );
  });

  it('prints ! for a feed that cannot be parsed', async () => {
    const { code, text } = await runDoctor({
      fetch: async () => new Response('<html>not a feed</html>', { status: 200 }),
    });

    expect(code).toBe(0);
    expect(resultFor(text, '!', 'source example-feed:')).toBeDefined();
  });

  it('prints ! when a source does not answer within the timeout', async () => {
    const { code, text } = await runDoctor({
      sourceTimeoutMs: 20,
      fetch: () => new Promise<Response>(() => undefined),
    });

    expect(code).toBe(0);
    expect(resultFor(text, '!', 'source example-feed:')).toMatch(/timed out/i);
  });

  it('reports each source on its own and keeps config order', async () => {
    const { text } = await runDoctor({
      config: {
        sources: [
          { id: 'first', kind: 'rss', url: 'https://one.example.com/feed.xml' },
          { id: 'second', kind: 'rss', url: 'https://two.example.com/feed.xml' },
          { id: 'third', kind: 'rss', url: 'https://three.example.com/feed.xml' },
        ],
      },
      fetch: async (input) =>
        urlOf(input).startsWith('https://two.')
          ? new Response('no', { status: 500 })
          : new Response(ATOM_FEED, { status: 200 }),
    });

    expect(resultFor(text, '✓', 'source first:')).toBeDefined();
    expect(resultFor(text, '!', 'source second:')).toBeDefined();
    expect(resultFor(text, '✓', 'source third:')).toBeDefined();
    expect(text.indexOf('source first')).toBeLessThan(text.indexOf('source second'));
    expect(text.indexOf('source second')).toBeLessThan(text.indexOf('source third'));
  });
});
