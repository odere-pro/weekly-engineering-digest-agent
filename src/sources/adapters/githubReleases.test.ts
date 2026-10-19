import { readFileSync } from 'node:fs';
import { extractFromXml } from '@extractus/feed-extractor';
import type * as FeedExtractor from '@extractus/feed-extractor';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGithubReleasesFetcher } from './githubReleases';
import { ItemSchema, type Source } from '../../domain/schemas';
import type { FetchWindow } from '../SourceFetcher';
import { FetchError } from '../../shared/errors';
import { itemIdFor } from '../../shared/url';

// Delegates to the real parser unless a test overrides it, to model a library that words its
// failures differently.
vi.mock('@extractus/feed-extractor', async (importOriginal) => {
  const actual = await importOriginal<typeof FeedExtractor>();
  return { ...actual, extractFromXml: vi.fn(actual.extractFromXml) };
});
const { extractFromXml: actualExtract } = await vi.importActual<typeof FeedExtractor>(
  '@extractus/feed-extractor',
);

const fixture = (name: string): string =>
  readFileSync(new URL(`./__fixtures__/github/${name}`, import.meta.url), 'utf8');

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

  describe('an empty releases feed', () => {
    const emptyFeed = readFileSync(
      new URL('./__fixtures__/sources/github-empty.atom', import.meta.url),
      'utf8',
    );

    /** Parses with the real library, then fails the way a future version might word it. */
    function rewordedFailure(message: string): void {
      vi.mocked(extractFromXml).mockImplementationOnce((xml, parserOptions) => {
        try {
          actualExtract(xml, parserOptions);
        } catch {
          // the real library reports its own wording; the test replaces it
        }
        throw new Error(message);
      });
    }

    it('returns no items for the feed GitHub serves for a repository without releases', async () => {
      const { fetch } = fakeFetch(() => ok(emptyFeed));

      await expect(createGithubReleasesFetcher({ fetch }).fetch(source, window)).resolves.toEqual(
        [],
      );
    });

    it('recognizes it by its shape, whatever the library says about it', async () => {
      rewordedFailure('This is not a feed we know');
      const { fetch } = fakeFetch(() => ok(emptyFeed));

      await expect(createGithubReleasesFetcher({ fetch }).fetch(source, window)).resolves.toEqual(
        [],
      );
    });

    it('does not take a feed with entries for an empty one when the library fails on it', async () => {
      rewordedFailure('Unrecognized feed format');
      const { fetch } = fakeFetch(() => ok(ATOM));

      await expect(createGithubReleasesFetcher({ fetch }).fetch(source, window)).rejects.toThrow(
        /Malformed releases feed for acme-widgets/,
      );
    });

    it('does not take a document that is not well-formed for an empty feed', async () => {
      rewordedFailure('Unrecognized feed format');
      const { fetch } = fakeFetch(() => ok(emptyFeed.replace('</feed>', '')));

      await expect(createGithubReleasesFetcher({ fetch }).fetch(source, window)).rejects.toThrow(
        /Malformed releases feed for acme-widgets/,
      );
    });

    it('does not take a document the parser refuses part way for an empty feed', async () => {
      const nested =
        '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>t</title>' +
        '<x>'.repeat(150) +
        '</x>'.repeat(150) +
        '</feed>';
      const { fetch } = fakeFetch(() => ok(nested));

      await expect(createGithubReleasesFetcher({ fetch }).fetch(source, window)).rejects.toThrow(
        /Malformed releases feed for acme-widgets/,
      );
    });

    it('accepts the nesting a real empty feed has, such as author/name', async () => {
      const feed = emptyFeed.replace('</feed>', '<author><name>acme</name></author></feed>');
      const { fetch } = fakeFetch(() => ok(feed));

      await expect(createGithubReleasesFetcher({ fetch }).fetch(source, window)).resolves.toEqual(
        [],
      );
    });

    it.each([
      ['an empty feed without the Atom namespace', '<feed><title>x</title></feed>'],
      [
        'an empty feed in another namespace',
        '<feed xmlns="http://example.com/other"><title>x</title></feed>',
      ],
    ])('still reports %s as malformed', async (_label, body) => {
      const { fetch } = fakeFetch(() => ok(body));

      await expect(createGithubReleasesFetcher({ fetch }).fetch(source, window)).rejects.toThrow(
        /Malformed releases feed for acme-widgets/,
      );
    });
  });

  describe('redirects', () => {
    const moved = (location: string): Response =>
      new Response(null, { status: 301, headers: { location } });
    const RENAMED = 'https://github.com/acme/gadgets/releases.atom';

    it('follows a renamed repository on github.com and handles redirects itself', async () => {
      const { fetch, calls } = fakeFetch(({ url }) =>
        url === ATOM_URL ? moved(RENAMED) : ok(ATOM),
      );

      const items = await createGithubReleasesFetcher({ fetch }).fetch(source, window);

      expect(items).toHaveLength(3);
      expect(calls.map((call) => call.url)).toEqual([ATOM_URL, RENAMED]);
      expect(calls.every((call) => call.init?.redirect === 'manual')).toBe(true);
    });

    it.each([
      'https://www.github.com/acme/widgets/releases.atom',
      'https://api.github.com/acme/widgets/releases.atom',
    ])('follows a redirect to %s', async (target) => {
      const { fetch, calls } = fakeFetch(({ url }) =>
        url === ATOM_URL ? moved(target) : ok(ATOM),
      );

      await createGithubReleasesFetcher({ fetch }).fetch(source, window);

      expect(calls).toHaveLength(2);
    });

    it('fails the source on a redirect to another host, without requesting it', async () => {
      const { fetch, calls } = fakeFetch(() => moved('https://evil.example.org/releases.atom'));

      const error = await createGithubReleasesFetcher({ fetch })
        .fetch(source, window)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(FetchError);
      expect(error).toMatchObject({ retryable: false });
      expect((error as Error).message).toContain('acme-widgets');
      expect((error as Error).message).toContain('evil.example.org');
      expect(calls).toHaveLength(1);
    });

    it('keeps the token on api.github.com and drops it on any other origin', async () => {
      const MOVED_API = 'https://api.github.com/repositories/42/releases?per_page=20';
      const MOVED_WEB = 'https://github.com/acme/widgets/releases.json';
      const { fetch, calls } = fakeFetch(({ url }) => {
        if (url === REST_URL) return moved(MOVED_API);
        return url === MOVED_API ? moved(MOVED_WEB) : ok(REST);
      });

      await createGithubReleasesFetcher({ fetch, token: TOKEN }).fetch(source, window);

      expect(calls.map((call) => call.url)).toEqual([REST_URL, MOVED_API, MOVED_WEB]);
      expect(calls[1]?.init?.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
      expect(JSON.stringify(calls[2]?.init?.headers).toLowerCase()).not.toContain('authorization');
    });

    it('fails a token request redirected to another host, without echoing the token', async () => {
      const { fetch, calls } = fakeFetch(() => moved('https://evil.example.org/steal'));

      const error = await createGithubReleasesFetcher({ fetch, token: TOKEN })
        .fetch(source, window)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(FetchError);
      expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(TOKEN);
      expect(calls).toHaveLength(1);
    });
  });

  describe('body size', () => {
    const huge = (): Response =>
      new Response('<feed/>', { headers: { 'content-length': String(5 * 1024 * 1024 + 1) } });

    it('refuses a releases feed over 5 MiB', async () => {
      const { fetch } = fakeFetch(huge);

      const error = await createGithubReleasesFetcher({ fetch })
        .fetch(source, window)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(FetchError);
      expect(error).toMatchObject({ retryable: false });
      expect((error as Error).message).toMatch(/acme-widgets.*5 MiB/);
    });

    it('refuses an API answer over 5 MiB, keeping the typed error and the token out of it', async () => {
      const { fetch } = fakeFetch(huge);

      const error = await createGithubReleasesFetcher({ fetch, token: TOKEN })
        .fetch(source, window)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(FetchError);
      expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(TOKEN);
    });
  });

  describe('typed failures', () => {
    it.each([
      [401, false],
      [403, false],
      [404, false],
      [408, true],
      [429, true],
      [500, true],
      [503, true],
    ])('HTTP %i is a FetchError with that status, retryable: %s', async (code, retryable) => {
      const { fetch } = fakeFetch(() => status(code));

      const error = await createGithubReleasesFetcher({ fetch })
        .fetch(source, window)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(FetchError);
      expect(error).toMatchObject({ status: code, retryable });
    });

    it.each([
      [403, { 'x-ratelimit-remaining': '0' }],
      [429, { 'retry-after': '60' }],
      [429, { 'x-ratelimit-remaining': '0' }],
    ])('a rate limit (HTTP %i, %j) keeps its status and is not retried', async (code, headers) => {
      const { fetch } = fakeFetch(() => status(code, headers));

      const error = await createGithubReleasesFetcher({ fetch, token: TOKEN })
        .fetch(source, window)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(FetchError);
      expect(error).toMatchObject({ status: code, retryable: false });
    });

    it('keeps the typed error when a token is set', async () => {
      const { fetch } = fakeFetch(() => status(503));

      const error = await createGithubReleasesFetcher({ fetch, token: TOKEN })
        .fetch(source, window)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(FetchError);
      expect(error).toMatchObject({ status: 503, retryable: true });
    });

    it.each([
      [
        'a bad repository URL',
        { ...source, url: 'https://example.com/acme/widgets' },
        undefined,
        () => ok(ATOM),
      ],
      ['an Atom document that is not a feed', source, undefined, () => ok('<html></html>')],
      ['a REST body that is not JSON', source, TOKEN, () => ok('<html></html>')],
      ['a REST payload that is not a list', source, TOKEN, () => json({ message: 'Not Found' })],
      [
        'a feed whose entries all lack a link or date',
        source,
        undefined,
        () => ok(atomFeed([atomEntry('v1', null)])),
      ],
    ])('%s is a FetchError no retry can fix', async (_label, target, token, respond) => {
      const { fetch } = fakeFetch(respond);

      const error = await createGithubReleasesFetcher({ fetch, token })
        .fetch(target, window)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(FetchError);
      expect(error).toMatchObject({ retryable: false });
    });
  });
});
