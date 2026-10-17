import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGithubReleasesFetcher } from '../../../src/adapters/sources/githubReleases.js';
import { ItemSchema, type Source } from '../../../src/core/schemas.js';
import type { FetchWindow } from '../../../src/ports/SourceFetcher.js';
import { itemIdFor } from '../../../src/shared/url.js';

const fixture = (name: string): string =>
  readFileSync(new URL(`../../fixtures/github/${name}`, import.meta.url), 'utf8');

const ATOM = fixture('releases.atom');
const REST = fixture('releases.json');

const TOKEN = 'ghp_SECRET_TOKEN_0123456789';
const ATOM_URL = 'https://github.com/acme/widgets/releases.atom';
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

function atomFeed(entries: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><id>tag:github.com,2008:releases</id>
<title>Release notes</title><updated>2026-10-12T09:00:00Z</updated>${entries.join('')}</feed>`;
}

function atomEntry(tag: string, updated: string | null, title = tag, link?: string): string {
  const href = link ?? `https://github.com/acme/widgets/releases/tag/${tag}`;
  return `<entry><id>tag:github.com,2008:Repository/1/${tag}</id>${
    updated === null ? '' : `<updated>${updated}</updated>`
  }${href === '' ? '' : `<link rel="alternate" type="text/html" href="${href}"/>`}<title>${title}</title><content type="html">notes for ${tag}</content></entry>`;
}

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
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is a github fetcher', () => {
    expect(createGithubReleasesFetcher().kind).toBe('github');
  });

  describe('repository URL', () => {
    it.each([
      ['a bare owner', 'https://github.com/acme'],
      ['a plain-http URL', 'http://github.com/acme/widgets'],
      ['another host', 'https://gitlab.com/acme/widgets'],
      ['a subpage of the repository', 'https://github.com/acme/widgets/issues'],
      ['a dot-dot repository name', 'https://github.com/acme/..'],
      ['a clone URL ending in .git', 'https://github.com/acme/widgets.git'],
      ['a query string', 'https://github.com/acme/widgets?tab=readme'],
      ['embedded credentials', 'https://user:pw@github.com/acme/widgets'],
      ['a lookalike host', 'https://github.com.evil.example/acme/widgets'],
      ['text that is not a URL', 'acme/widgets'],
    ])('rejects %s before any request', async (_label, url) => {
      const { fetch, calls } = fakeFetch(() => ok(ATOM));
      const fetcher = createGithubReleasesFetcher({ fetch });

      await expect(fetcher.fetch({ ...source, url }, window)).rejects.toThrow(
        /acme-widgets.*https:\/\/github\.com\/<owner>\/<repo>/,
      );
      expect(calls).toHaveLength(0);
    });

    it('does not echo a URL that carries credentials', async () => {
      const { fetch } = fakeFetch(() => ok(ATOM));
      const url = `https://github.com/acme/widgets?access_token=${TOKEN}`;

      const error = await createGithubReleasesFetcher({ fetch })
        .fetch({ ...source, url }, window)
        .catch((e: unknown) => e);

      expect((error as Error).message).toContain('acme-widgets');
      expect((error as Error).message).not.toContain(TOKEN);
    });

    it('accepts a trailing slash', async () => {
      const { fetch, calls } = fakeFetch(() => ok(ATOM));
      const fetcher = createGithubReleasesFetcher({ fetch });

      await fetcher.fetch({ ...source, url: 'https://github.com/acme/widgets/' }, window);

      expect(calls[0]?.url).toBe(ATOM_URL);
    });
  });

  describe('without a token (releases.atom)', () => {
    it('requests the repository releases.atom without credentials and passes the abort signal', async () => {
      const { fetch, calls } = fakeFetch(() => ok(ATOM));
      const signal = new AbortController().signal;

      await createGithubReleasesFetcher({ fetch }).fetch(source, window, signal);

      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe(ATOM_URL);
      expect(calls[0]?.init?.signal).toBe(signal);
      expect(JSON.stringify(calls[0]?.init?.headers ?? {}).toLowerCase()).not.toContain(
        'authorization',
      );
    });

    it('treats a blank token as no token', async () => {
      const { fetch, calls } = fakeFetch(() => ok(ATOM));

      await createGithubReleasesFetcher({ fetch, token: '  ' }).fetch(source, window);

      expect(calls[0]?.url).toBe(ATOM_URL);
    });

    it('parses the recorded feed into valid items, newest first, inside the window', async () => {
      const { fetch } = fakeFetch(() => ok(ATOM));

      const items = await createGithubReleasesFetcher({ fetch }).fetch(source, window);

      expect(items.map((item) => item.url)).toEqual([
        'https://github.com/acme/widgets/releases/tag/v2.4.0',
        'https://github.com/acme/widgets/releases/tag/tools/v1.0.0',
        'https://github.com/acme/widgets/releases/tag/v2.3.1',
      ]);
      for (const item of items) {
        expect(ItemSchema.parse(item)).toEqual(item);
        expect(item.kind).toBe('github');
        expect(item.sourceId).toBe('acme-widgets');
        expect(item.id).toBe(itemIdFor(item.url));
      }
      expect(items[0]?.publishedAt).toBe('2026-10-12T09:00:00.000Z');
    });

    it('titles items "<repo> <tag>: <name>" and does not repeat a name equal to the tag', async () => {
      const { fetch } = fakeFetch(() => ok(ATOM));

      const items = await createGithubReleasesFetcher({ fetch }).fetch(source, window);

      expect(items.map((item) => item.title)).toEqual([
        'widgets v2.4.0: Faster startup',
        'widgets tools/v1.0.0: Tooling split',
        'widgets v2.3.1',
      ]);
    });

    it('turns the release notes into plain text', async () => {
      const { fetch } = fakeFetch(() => ok(ATOM));

      const [latest] = await createGithubReleasesFetcher({ fetch }).fetch(source, window);

      expect(latest?.summary).toContain("What's Changed");
      expect(latest?.summary).toContain('Cold start is 40% faster & uses less memory');
      expect(latest?.summary).toContain('--json');
      expect(latest?.summary).not.toMatch(/[<>]|&amp;|&lt;/);
    });

    it('truncates the summary to maxSummaryChars', async () => {
      const { fetch } = fakeFetch(() => ok(ATOM));

      const [latest] = await createGithubReleasesFetcher({ fetch, maxSummaryChars: 40 }).fetch(
        source,
        window,
      );

      expect(latest?.summary.length).toBeLessThanOrEqual(40);
      expect(latest?.summary.endsWith('...')).toBe(true);
    });

    it('truncates to 600 characters by default', async () => {
      const feed = atomFeed([
        atomEntry('v9.0.0', '2026-10-12T09:00:00Z').replace(
          'notes for v9.0.0',
          '&lt;p&gt;' + 'word '.repeat(400) + '&lt;/p&gt;',
        ),
      ]);
      const { fetch } = fakeFetch(() => ok(feed));

      const [item] = await createGithubReleasesFetcher({ fetch }).fetch(source, window);

      expect(item?.summary.length).toBeLessThanOrEqual(600);
      expect(item?.summary.length).toBeGreaterThan(500);
    });

    it('keeps entries on the window boundaries and drops those outside', async () => {
      const feed = atomFeed([
        atomEntry('v1.0.4', '2026-10-15T00:00:01Z'),
        atomEntry('v1.0.3', '2026-10-15T00:00:00Z'),
        atomEntry('v1.0.2', '2026-10-05T00:00:00Z'),
        atomEntry('v1.0.1', '2026-10-04T23:59:59Z'),
      ]);
      const { fetch } = fakeFetch(() => ok(feed));

      const items = await createGithubReleasesFetcher({ fetch }).fetch(source, window);

      expect(items.map((item) => item.title)).toEqual(['widgets v1.0.3', 'widgets v1.0.2']);
    });

    it('sorts newest first and keeps at most maxItems', async () => {
      const feed = atomFeed([
        atomEntry('v1.0.0', '2026-10-06T00:00:00Z'),
        atomEntry('v1.0.3', '2026-10-09T00:00:00Z'),
        atomEntry('v1.0.1', '2026-10-07T00:00:00Z'),
        atomEntry('v1.0.2', '2026-10-08T00:00:00Z'),
      ]);
      const { fetch } = fakeFetch(() => ok(feed));

      const items = await createGithubReleasesFetcher({ fetch }).fetch(source, {
        ...window,
        maxItems: 2,
      });

      expect(items.map((item) => item.title)).toEqual(['widgets v1.0.3', 'widgets v1.0.2']);
    });

    it('drops entries without a usable link or date', async () => {
      const feed = atomFeed([
        atomEntry('v1.0.1', null),
        atomEntry('v1.0.2', 'not a date'),
        atomEntry('v1.0.3', '2026-10-08T00:00:00Z', 'v1.0.3', ''),
        atomEntry('v1.0.4', '2026-10-08T00:00:00Z', 'v1.0.4', 'ftp://example.com/v1.0.4'),
        atomEntry(
          'v1.0.6',
          '2026-10-08T00:00:00Z',
          'v1.0.6',
          'https://evil.example/releases/tag/v1',
        ),
        atomEntry('v1.0.5', '2026-10-08T00:00:00Z'),
      ]);
      const { fetch } = fakeFetch(() => ok(feed));

      const items = await createGithubReleasesFetcher({ fetch }).fetch(source, window);

      expect(items.map((item) => item.title)).toEqual(['widgets v1.0.5']);
    });

    it('fails the source when no entry has a usable link and date', async () => {
      const feed = atomFeed([atomEntry('v1.0.1', null), atomEntry('v1.0.2', 'not a date')]);
      const { fetch } = fakeFetch(() => ok(feed));

      await expect(createGithubReleasesFetcher({ fetch }).fetch(source, window)).rejects.toThrow(
        /Unexpected releases feed for acme-widgets/,
      );
    });

    it('keeps a release whose notes carry an out-of-range character reference', async () => {
      const feed = atomFeed([
        atomEntry('v1.0.0', '2026-10-08T00:00:00Z').replace(
          'notes for v1.0.0',
          '&amp;#x110000; and &amp;#99999999;',
        ),
        atomEntry('v1.0.1', '2026-10-07T00:00:00Z'),
      ]);
      const { fetch } = fakeFetch(() => ok(feed));

      const items = await createGithubReleasesFetcher({ fetch }).fetch(source, window);

      expect(items.map((item) => [item.title, item.summary])).toEqual([
        ['widgets v1.0.0', '&#x110000; and &#99999999;'],
        ['widgets v1.0.1', 'notes for v1.0.1'],
      ]);
    });

    it('decodes the tag from the release URL, with a fallback for bad escapes', async () => {
      const feed = atomFeed([
        atomEntry(
          'plus',
          '2026-10-08T00:00:00Z',
          'Plus',
          'https://github.com/acme/widgets/releases/tag/v1.0.0%2Bbuild.5',
        ),
        atomEntry(
          'bad',
          '2026-10-09T00:00:00Z',
          'Bad',
          'https://github.com/acme/widgets/releases/tag/v1%',
        ),
        atomEntry(
          'other',
          '2026-10-10T00:00:00Z',
          'Elsewhere',
          'https://github.com/acme/widgets/releases/latest',
        ),
      ]);
      const { fetch } = fakeFetch(() => ok(feed));

      const items = await createGithubReleasesFetcher({ fetch }).fetch(source, window);

      expect(items.map((item) => item.title)).toEqual([
        'widgets Elsewhere',
        'widgets v1%: Bad',
        'widgets v1.0.0+build.5: Plus',
      ]);
    });

    it('returns no items for a repository without releases', async () => {
      const { fetch } = fakeFetch(() => ok(atomFeed([])));

      await expect(createGithubReleasesFetcher({ fetch }).fetch(source, window)).resolves.toEqual(
        [],
      );
    });

    it('throws naming the source on an HTTP error', async () => {
      const { fetch } = fakeFetch(() => status(404));

      await expect(createGithubReleasesFetcher({ fetch }).fetch(source, window)).rejects.toThrow(
        'HTTP 404 fetching acme-widgets',
      );
    });

    it.each([
      ['an HTML page', '<html><body>not a feed</body></html>'],
      ['text that is not XML', 'Service Unavailable'],
      [
        'an Atom feed cut off mid-entry',
        atomFeed([atomEntry('v1.0.0', '2026-10-08T00:00:00Z')]).slice(0, -20),
      ],
      ['an Atom-looking feed without the Atom namespace', '<feed><title>x</title></feed>'],
    ])('throws naming the source on %s', async (_label, body) => {
      const { fetch } = fakeFetch(() => ok(body));

      await expect(createGithubReleasesFetcher({ fetch }).fetch(source, window)).rejects.toThrow(
        /Malformed releases feed for acme-widgets/,
      );
    });

    it('reports a rate limit when GitHub answers 429 with retry-after', async () => {
      const { fetch } = fakeFetch(() => status(429, { 'retry-after': '60' }));

      await expect(createGithubReleasesFetcher({ fetch }).fetch(source, window)).rejects.toThrow(
        /rate limit.*acme-widgets/i,
      );
    });

    it('falls back to the global fetch when none is injected', async () => {
      const { fetch, calls } = fakeFetch(() => ok(ATOM));
      vi.stubGlobal('fetch', fetch);

      const items = await createGithubReleasesFetcher().fetch(source, window);

      expect(calls[0]?.url).toBe(ATOM_URL);
      expect(items).toHaveLength(3);
    });
  });

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
      const aborted = {
        ok: true,
        status: 200,
        headers: new Headers(),
        text: () => Promise.reject(new DOMException('This operation was aborted', 'AbortError')),
      } as unknown as Response;
      const { fetch } = fakeFetch(() => aborted);

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
