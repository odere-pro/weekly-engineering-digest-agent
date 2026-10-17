import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGithubReleasesFetcher } from '../../../src/adapters/sources/githubReleases.js';
import type { Source } from '../../../src/core/schemas.js';
import type { FetchWindow } from '../../../src/ports/SourceFetcher.js';
import { noopLogger } from '../../../src/shared/telemetry.js';
import { toPlainText } from '../../../src/shared/text.js';

// Real unless a test makes one release blow up, like the RSS fetcher's tests (W5-01, F18).
vi.mock('../../../src/shared/text.js', async (importOriginal) => {
  const actual = await importOriginal<{ toPlainText: typeof toPlainText }>();
  return { ...actual, toPlainText: vi.fn(actual.toPlainText) };
});
const { toPlainText: realToPlainText } = await vi.importActual<{
  toPlainText: typeof toPlainText;
}>('../../../src/shared/text.js');

const SKIPPED = 'Skipped feed entries that could not be read';
const TOKEN = 'ghp_SECRET_TOKEN_0123456789';

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

interface Release {
  tag: string;
  publishedAt: string;
  prerelease?: boolean;
  draft?: boolean;
}

const FIRST: Release = { tag: 'v1.0.0', publishedAt: '2026-10-08T00:00:00Z' };
const SECOND: Release = { tag: 'v1.0.1', publishedAt: '2026-10-07T00:00:00Z' };

const releaseUrl = (tag: string): string => `https://github.com/acme/widgets/releases/tag/${tag}`;

function atomFeed(releases: readonly Release[]): string {
  const entries = releases.map(
    ({ tag, publishedAt }) =>
      `<entry><id>tag:github.com,2008:Repository/1/${tag}</id><updated>${publishedAt}</updated>` +
      `<link rel="alternate" type="text/html" href="${releaseUrl(tag)}"/><title>${tag}</title>` +
      `<content type="html">notes for ${tag}</content></entry>`,
  );
  return `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><id>tag:github.com,2008:releases</id><title>Release notes</title><updated>2026-10-12T09:00:00Z</updated>${entries.join('')}</feed>`;
}

function restBody(releases: readonly Release[]): string {
  return JSON.stringify(
    releases.map(({ tag, publishedAt, prerelease = false, draft = false }) => ({
      tag_name: tag,
      name: tag,
      html_url: releaseUrl(tag),
      draft,
      prerelease,
      published_at: publishedAt,
      body: `notes for ${tag}`,
    })),
  );
}

interface Transport {
  name: string;
  options: { token?: string };
  body: (releases: readonly Release[]) => string;
}

const TRANSPORTS: readonly Transport[] = [
  { name: 'the releases Atom feed', options: {}, body: atomFeed },
  { name: 'the REST API', options: { token: TOKEN }, body: restBody },
];

function loggerWithWarn() {
  const warn = vi.fn();
  return { warn, logger: { ...noopLogger, warn } };
}

/** The notes of the releases named here (by tag) fail to convert, each with its own error. */
function failFor(failures: Readonly<Record<string, unknown>>): void {
  vi.mocked(toPlainText).mockImplementation((text) => {
    for (const [tag, thrown] of Object.entries(failures)) {
      if (text.includes(`notes for ${tag}`)) throw thrown;
    }
    return realToPlainText(text);
  });
}

const CODE_POINT_ERROR = new RangeError('Invalid code point 1114112');

beforeEach(() => {
  vi.mocked(toPlainText).mockImplementation(realToPlainText);
});

describe.each(TRANSPORTS)('GitHub releases through $name: logging', (transport) => {
  const respondWith = (releases: readonly Release[]) =>
    vi.fn<typeof fetch>(async () => new Response(transport.body(releases), { status: 200 }));

  it('skips a release it cannot read, keeps the other, and warns once for the source', async () => {
    failFor({ [FIRST.tag]: CODE_POINT_ERROR });
    const { warn, logger } = loggerWithWarn();
    const fetch = respondWith([FIRST, SECOND]);

    const items = await createGithubReleasesFetcher({
      ...transport.options,
      fetch,
      logger,
    }).fetch(source, window);

    expect(items.map((item) => item.title)).toEqual(['widgets v1.0.1']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(SKIPPED, {
      sourceId: 'acme-widgets',
      failed: 1,
      of: 2,
      firstError: 'Invalid code point 1114112',
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN);
  });

  it('logs one line however many releases fail', async () => {
    failFor({ [FIRST.tag]: new Error('first'), [SECOND.tag]: new Error('second') });
    const { warn, logger } = loggerWithWarn();

    const items = await createGithubReleasesFetcher({
      ...transport.options,
      fetch: respondWith([FIRST, SECOND]),
      logger,
    }).fetch(source, window);

    expect(items).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      SKIPPED,
      expect.objectContaining({ sourceId: 'acme-widgets', failed: 2, of: 2, firstError: 'first' }),
    );
  });

  it('stays quiet when every release can be read', async () => {
    const { warn, logger } = loggerWithWarn();

    const items = await createGithubReleasesFetcher({
      ...transport.options,
      fetch: respondWith([FIRST, SECOND]),
      logger,
    }).fetch(source, window);

    expect(items).toHaveLength(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it('stays quiet for a repository without releases', async () => {
    const { warn, logger } = loggerWithWarn();

    const items = await createGithubReleasesFetcher({
      ...transport.options,
      fetch: respondWith([]),
      logger,
    }).fetch(source, window);

    expect(items).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('skips the release quietly when no logger is given', async () => {
    failFor({ [FIRST.tag]: CODE_POINT_ERROR });

    const items = await createGithubReleasesFetcher({
      ...transport.options,
      fetch: respondWith([FIRST, SECOND]),
    }).fetch(source, window);

    expect(items.map((item) => item.title)).toEqual(['widgets v1.0.1']);
  });
});

describe('GitHub releases through the REST API: drafts and prereleases', () => {
  it('leaves them out on purpose, without a warning', async () => {
    const { warn, logger } = loggerWithWarn();
    const releases = [
      { ...FIRST, prerelease: true },
      { ...SECOND, draft: true },
      { tag: 'v0.9.0', publishedAt: '2026-10-06T00:00:00Z' },
    ];

    const items = await createGithubReleasesFetcher({
      token: TOKEN,
      fetch: vi.fn<typeof fetch>(async () => new Response(restBody(releases), { status: 200 })),
      logger,
    }).fetch(source, window);

    expect(items.map((item) => item.title)).toEqual(['widgets v0.9.0']);
    expect(warn).not.toHaveBeenCalled();
  });
});
