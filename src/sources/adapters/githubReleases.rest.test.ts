import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createGithubReleasesFetcher } from './githubReleases';
import { ItemSchema, type Source } from '../../domain/schemas';
import type { FetchWindow } from '../SourceFetcher';
import { itemIdFor } from '../../shared/url';

const fixture = (name: string): string =>
  readFileSync(new URL(`./__fixtures__/github/${name}`, import.meta.url), 'utf8');

const REST = fixture('releases.json');

const TOKEN = 'ghp_SECRET_TOKEN_0123456789';
const REST_URL = 'https://api.github.com/repos/acme/widgets/releases?per_page=20';

const source: Source = {
  id: 'acme-widgets',
  kind: 'github',
  url: 'https://github.com/acme/widgets',
};
const window: FetchWindow = {
  since: new Date('2026-10-05T00:00:00Z'),
  until: new Date('2026-10-15T00:00:00Z'),
  maxItems: 10,
};

interface Call {
  url: string;
  init: RequestInit | undefined;
}

type Responder = (call: Call) => Response | Promise<Response>;

/** A fetch fake that records calls and answers each with `respond`. */
function fakeFetch(respond: Responder): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fake = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const call = { url, init };
    calls.push(call);
    return Promise.resolve(respond(call));
  };
  return { fetch: fake, calls };
}

const ok = (body: string): Response => new Response(body, { status: 200 });
const status = (code: number, headers: Record<string, string> = {}): Response =>
  new Response('upstream detail that must not leak', { status: code, headers });

function restRelease(tag: string, publishedAt: string, extra: Record<string, unknown> = {}) {
  return {
    tag_name: tag,
    name: tag,
    html_url: `https://github.com/acme/widgets/releases/tag/${tag}`,
    draft: false,
    prerelease: false,
    published_at: publishedAt,
    body: `notes for ${tag}`,
    ...extra,
  };
}

const json = (value: unknown): Response => ok(JSON.stringify(value));

describe('createGithubReleasesFetcher', () => {
  describe('with a token (REST API)', () => {
    it('sends the auth headers to the releases endpoint and passes the abort signal', async () => {
      const { fetch, calls } = fakeFetch(() => ok(REST));
      const signal = new AbortController().signal;

      await createGithubReleasesFetcher({ fetch, token: ` ${TOKEN} ` }).fetch(
        source,
        window,
        signal,
      );

      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe(REST_URL);
      expect(calls[0]?.init?.signal).toBe(signal);
      expect(calls[0]?.init?.headers).toEqual({
        Authorization: `Bearer ${TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      });
    });

    it('skips drafts and prereleases and maps the rest to valid items', async () => {
      const { fetch } = fakeFetch(() => ok(REST));

      const items = await createGithubReleasesFetcher({ fetch, token: TOKEN }).fetch(source, {
        ...window,
        since: new Date('2026-09-01T00:00:00Z'),
      });

      expect(items.map((item) => item.title)).toEqual([
        'widgets v2.4.0: Faster startup',
        'widgets v2.3.1',
        'widgets v2.3.0',
      ]);
      for (const item of items) {
        expect(ItemSchema.parse(item)).toEqual(item);
        expect(item.kind).toBe('github');
        expect(item.sourceId).toBe('acme-widgets');
        expect(item.id).toBe(itemIdFor(item.url));
      }
      expect(items[0]?.url).toBe('https://github.com/acme/widgets/releases/tag/v2.4.0');
      expect(items[0]?.publishedAt).toBe('2026-10-12T09:00:00.000Z');
      expect(items[2]?.summary).toBe('');
    });

    it('turns the Markdown body into truncated plain text', async () => {
      const { fetch } = fakeFetch(() => ok(REST));

      const [latest] = await createGithubReleasesFetcher({
        fetch,
        token: TOKEN,
        maxSummaryChars: 60,
      }).fetch(source, window);

      expect(latest?.summary.length).toBeLessThanOrEqual(60);
      expect(latest?.summary.endsWith('...')).toBe(true);
      expect(latest?.summary).toContain("What's Changed");
    });

    it('truncates to 600 characters by default', async () => {
      const long = restRelease('v9.0.0', '2026-10-12T09:00:00Z', { body: 'word '.repeat(400) });
      const { fetch } = fakeFetch(() => json([long]));

      const [item] = await createGithubReleasesFetcher({ fetch, token: TOKEN }).fetch(
        source,
        window,
      );

      expect(item?.summary.length).toBeLessThanOrEqual(600);
      expect(item?.summary.length).toBeGreaterThan(500);
    });

    it('applies the window, newest first, and the maxItems cap', async () => {
      const releases = [
        restRelease('v1.0.0', '2026-10-06T00:00:00Z'),
        restRelease('v1.0.3', '2026-10-09T00:00:00Z'),
        restRelease('v0.9.0', '2026-10-04T23:59:59Z'),
        restRelease('v1.0.4', '2026-10-15T00:00:01Z'),
        restRelease('v1.0.2', '2026-10-08T00:00:00Z'),
        restRelease('v1.0.1', '2026-10-07T00:00:00Z'),
      ];
      const { fetch } = fakeFetch(() => json(releases));
      const fetcher = createGithubReleasesFetcher({ fetch, token: TOKEN });

      const all = await fetcher.fetch(source, window);
      const capped = await fetcher.fetch(source, { ...window, maxItems: 2 });

      expect(all.map((item) => item.title)).toEqual([
        'widgets v1.0.3',
        'widgets v1.0.2',
        'widgets v1.0.1',
        'widgets v1.0.0',
      ]);
      expect(capped.map((item) => item.title)).toEqual(['widgets v1.0.3', 'widgets v1.0.2']);
    });

    it('skips releases that are malformed or have no usable URL or date', async () => {
      const releases = [
        { name: 'no tag at all' },
        'not an object',
        restRelease('v1.0.1', '2026-10-08T00:00:00Z', { html_url: 'javascript:alert(1)' }),
        restRelease('v1.0.5', '2026-10-08T00:00:00Z', { html_url: 'https://evil.example/x' }),
        restRelease('v1.0.2', 'garbage'),
        restRelease('v1.0.3', '2026-10-08T00:00:00Z', { published_at: null }),
        restRelease('v1.0.4', '2026-10-08T00:00:00Z'),
      ];
      const { fetch } = fakeFetch(() => json(releases));

      const items = await createGithubReleasesFetcher({ fetch, token: TOKEN }).fetch(
        source,
        window,
      );

      expect(items.map((item) => item.title)).toEqual(['widgets v1.0.4']);
    });

    it('skips a draft or prerelease even when it has a publication date in the window', async () => {
      const releases = [
        restRelease('v1.0.1', '2026-10-08T00:00:00Z', { draft: true }),
        restRelease('v1.0.2', '2026-10-08T00:00:00Z', { prerelease: true }),
        restRelease('v1.0.3', '2026-10-08T00:00:00Z'),
      ];
      const { fetch } = fakeFetch(() => json(releases));

      const items = await createGithubReleasesFetcher({ fetch, token: TOKEN }).fetch(
        source,
        window,
      );

      expect(items.map((item) => item.title)).toEqual(['widgets v1.0.3']);
    });

    it('fails the source when no release matches the API shape', async () => {
      const { fetch } = fakeFetch(() => json([{ name: 'x' }, 42, null]));

      await expect(
        createGithubReleasesFetcher({ fetch, token: TOKEN }).fetch(source, window),
      ).rejects.toThrow(/Unexpected GitHub API response fetching acme-widgets/);
    });

    it('returns no items for an empty release list', async () => {
      const { fetch } = fakeFetch(() => json([]));

      await expect(
        createGithubReleasesFetcher({ fetch, token: TOKEN }).fetch(source, window),
      ).resolves.toEqual([]);
    });

    it('keeps angle brackets inside Markdown code, inline and fenced', async () => {
      const body = [
        'Adds `Option<T>` and <b>bold</b> notes.',
        '```ts',
        'const m: Map<K, V> = new Map();',
        '```',
        'Done.',
      ].join('\n');
      const { fetch } = fakeFetch(() =>
        json([restRelease('v1.0.0', '2026-10-08T00:00:00Z', { body })]),
      );

      const [item] = await createGithubReleasesFetcher({ fetch, token: TOKEN }).fetch(
        source,
        window,
      );

      expect(item?.summary).toContain('Option<T>');
      expect(item?.summary).toContain('Map<K, V>');
      expect(item?.summary).toContain('bold notes');
      expect(item?.summary).not.toContain('<b>');
    });

    it('handles Windows line endings and an unterminated code fence', async () => {
      const body = 'Intro\r\n```ts\r\nconst a: Array<number> = [];\r\n';
      const { fetch } = fakeFetch(() =>
        json([restRelease('v1.0.0', '2026-10-08T00:00:00Z', { body })]),
      );

      const [item] = await createGithubReleasesFetcher({ fetch, token: TOKEN }).fetch(
        source,
        window,
      );

      expect(item?.summary).toContain('Intro');
    });

    it('keeps a release whose notes carry an out-of-range character reference', async () => {
      const releases = [
        restRelease('v1.0.0', '2026-10-08T00:00:00Z', { body: 'boom &#x110000; &#99999999;' }),
        restRelease('v1.0.1', '2026-10-07T00:00:00Z'),
      ];
      const { fetch } = fakeFetch(() => json(releases));

      const items = await createGithubReleasesFetcher({ fetch, token: TOKEN }).fetch(
        source,
        window,
      );

      expect(items.map((item) => [item.title, item.summary])).toEqual([
        ['widgets v1.0.0', 'boom &#x110000; &#99999999;'],
        ['widgets v1.0.1', 'notes for v1.0.1'],
      ]);
    });

    it('collapses whitespace in the title so a release name cannot add lines', async () => {
      const releases = [
        restRelease('v1.0.0', '2026-10-08T00:00:00Z', { name: 'Big\n\n## Injected   heading ' }),
      ];
      const { fetch } = fakeFetch(() => json(releases));

      const [item] = await createGithubReleasesFetcher({ fetch, token: TOKEN }).fetch(
        source,
        window,
      );

      expect(item?.title).toBe('widgets v1.0.0: Big ## Injected heading');
    });

    it.each([
      [403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1791000000' }],
      [429, { 'x-ratelimit-remaining': '0' }],
      [403, { 'retry-after': '120' }],
    ])('reports a rate limit on HTTP %i (%j) without the token', async (code, headers) => {
      const { fetch } = fakeFetch(() => status(code, headers));
      const fetcher = createGithubReleasesFetcher({ fetch, token: TOKEN });

      const error = await fetcher.fetch(source, window).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/rate limit/i);
      expect((error as Error).message).toContain('acme-widgets');
      expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(TOKEN);
    });

    it('includes the reset time when GitHub provides it', async () => {
      const { fetch } = fakeFetch(() =>
        status(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1791000000' }),
      );

      await expect(
        createGithubReleasesFetcher({ fetch, token: TOKEN }).fetch(source, window),
      ).rejects.toThrow('resets at 2026-10-03T04:00:00.000Z');
    });

    it.each(['Infinity', '1e20', 'soon', ''])(
      'still reports the rate limit when the reset header is %j',
      async (reset) => {
        const { fetch } = fakeFetch(() =>
          status(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset }),
        );

        const error = await createGithubReleasesFetcher({ fetch, token: TOKEN })
          .fetch(source, window)
          .catch((e: unknown) => e);

        expect((error as Error).message).toBe(
          'GitHub rate limit hit fetching acme-widgets (HTTP 403)',
        );
      },
    );

    it('does not call a plain 403 a rate limit', async () => {
      const { fetch } = fakeFetch(() => status(403, { 'x-ratelimit-remaining': '4999' }));

      const error = await createGithubReleasesFetcher({ fetch, token: TOKEN })
        .fetch(source, window)
        .catch((e: unknown) => e);

      expect((error as Error).message).toBe('HTTP 403 fetching acme-widgets');
    });

    it('names the source on a rejected token (401) without echoing the token or the body', async () => {
      const { fetch } = fakeFetch(() => status(401));

      const error = await createGithubReleasesFetcher({ fetch, token: TOKEN })
        .fetch(source, window)
        .catch((e: unknown) => e);

      expect((error as Error).message).toBe('HTTP 401 fetching acme-widgets');
    });

    it('keeps the token out of a network failure', async () => {
      const { fetch } = fakeFetch(() =>
        Promise.reject(
          Object.assign(new Error(`socket hang up (Authorization: Bearer ${TOKEN})`), {
            cause: new Error(`inner ${TOKEN}`),
            headers: { authorization: `Bearer ${TOKEN}` },
          }),
        ),
      );

      const error = await createGithubReleasesFetcher({ fetch, token: TOKEN })
        .fetch(source, window)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('socket hang up');
      expect((error as Error).cause).toBeUndefined();
      expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(TOKEN);
    });

    it('keeps the error name so aborts and timeouts are still recognizable', async () => {
      const { fetch } = fakeFetch(() =>
        Promise.reject(new DOMException('This operation was aborted', 'AbortError')),
      );

      await expect(
        createGithubReleasesFetcher({ fetch, token: TOKEN }).fetch(source, window),
      ).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('rethrows a non-Error rejection as an Error without the token', async () => {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the point of this test
      const { fetch } = fakeFetch(() => Promise.reject(`weird ${TOKEN}`));

      const error = await createGithubReleasesFetcher({ fetch, token: TOKEN })
        .fetch(source, window)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(TOKEN);
    });

    it('leaves network errors untouched when there is no token', async () => {
      const failure = new Error('socket hang up');
      const { fetch } = fakeFetch(() => Promise.reject(failure));

      await expect(createGithubReleasesFetcher({ fetch }).fetch(source, window)).rejects.toBe(
        failure,
      );
    });

    it('keeps the error name when reading the body is aborted', async () => {
      const failing = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(new DOMException('This operation was aborted', 'AbortError'));
        },
      });
      const { fetch } = fakeFetch(() => new Response(failing));

      await expect(
        createGithubReleasesFetcher({ fetch, token: TOKEN }).fetch(source, window),
      ).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('throws naming the source when the body is not JSON, without quoting it', async () => {
      const { fetch } = fakeFetch(() => ok(`<html>oops ${TOKEN}</html>`));

      const error = await createGithubReleasesFetcher({ fetch, token: TOKEN })
        .fetch(source, window)
        .catch((e: unknown) => e);

      expect((error as Error).message).toMatch(/Malformed GitHub API response.*acme-widgets/);
      expect((error as Error).cause).toBeUndefined();
      expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(TOKEN);
    });

    it('throws naming the source when the payload is not a list', async () => {
      const { fetch } = fakeFetch(() => json({ message: 'Not Found' }));

      await expect(
        createGithubReleasesFetcher({ fetch, token: TOKEN }).fetch(source, window),
      ).rejects.toThrow(/Unexpected GitHub API response.*acme-widgets/);
    });
  });
});
