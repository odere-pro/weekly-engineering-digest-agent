import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { githubAtomAdapter } from './githubAtomAdapter';
import type { Reply } from './http';
import type { Source } from '../../domain/schemas';

const source: Source = { id: 'widgets', kind: 'github', url: 'https://github.com/acme/widgets' };
const reply = (body: string, status = 200, headers: Record<string, string> = {}): Reply => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(headers),
  body,
});
const feed = (entries: string): string =>
  `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><id>x</id><title>Releases</title>${entries}</feed>`;
const entry = (
  tag: string,
  updated: string | null,
  content = `notes ${tag}`,
  title = tag,
): string =>
  `<entry><id>tag:github.com,2008:Repository/1/${tag}</id>${updated ? `<updated>${updated}</updated>` : ''}<link rel="alternate" type="text/html" href="https://github.com/acme/widgets/releases/tag/${tag}"/><title>${title}</title><content type="html">${content}</content></entry>`;

describe('githubAtomAdapter', () => {
  it('requests the releases feed of the repository', async () => {
    const urls: string[] = [];
    await githubAtomAdapter.request(source, {} as never, async (url) => {
      urls.push(url);
      return reply(feed(''));
    });
    expect(urls).toEqual(['https://github.com/acme/widgets/releases.atom']);
    expect(githubAtomAdapter.kind).toBe('github');
    expect(githubAtomAdapter.enrichable).toBe(false);
  });

  it('refuses a source that is not a repository before any request', async () => {
    await expect(
      githubAtomAdapter.request(
        { ...source, url: 'https://gitlab.com/a/b' },
        {} as never,
        async () => reply(''),
      ),
    ).rejects.toThrow(/not a GitHub repository URL/);
  });

  it('throws a status failure, and a non-retryable one for a rate limit', async () => {
    await expect(
      githubAtomAdapter.request(source, {} as never, async () => reply('', 500)),
    ).rejects.toThrow('HTTP 500 fetching widgets');
    await expect(
      githubAtomAdapter.request(source, {} as never, async () =>
        reply('', 429, { 'retry-after': '60' }),
      ),
    ).rejects.toThrow(/rate limit/);
  });

  it('builds title from repo, tag and release name; keeps the notes as markup', () => {
    const [first] = githubAtomAdapter.parse(
      reply(
        feed(
          entry(
            'v1.2.0',
            '2026-10-10T08:00:00Z',
            '&lt;p&gt;Vec&amp;lt;T&amp;gt; fixed&lt;/p&gt;',
            'Big release',
          ),
        ),
      ),
      source,
    );
    expect(first).toMatchObject({
      url: 'https://github.com/acme/widgets/releases/tag/v1.2.0',
      title: 'widgets v1.2.0: Big release',
    });
    expect(first?.text).toContain('Vec');
    expect(first?.publishedAt).toBeInstanceOf(Date);
  });

  it('uses the tag alone when the release has no distinct name', () => {
    const [first] = githubAtomAdapter.parse(
      reply(feed(entry('v1', '2026-10-10T08:00:00Z'))),
      source,
    );
    expect(first?.title).toBe('widgets v1');
  });

  it('returns no entries for a repository without releases', () => {
    expect(
      githubAtomAdapter.parse(
        reply(
          readFileSync(
            new URL('./__fixtures__/sources/github-empty.atom', import.meta.url),
            'utf8',
          ),
        ),
        source,
      ),
    ).toEqual([]);
  });

  it('ignores entries without a date or off github.com and fails when none is usable', () => {
    const bad =
      entry('v1', null) +
      entry('v2', '2026-10-10T00:00:00Z').replace('https://github.com', 'https://evil.example');
    expect(() => githubAtomAdapter.parse(reply(feed(bad)), source)).toThrow(
      /no entry had a link and a date/,
    );
    const mixed = bad + entry('v3', '2026-10-10T00:00:00Z');
    expect(githubAtomAdapter.parse(reply(feed(mixed)), source)).toHaveLength(1);
  });

  it('throws a permanent failure for a body that is not a feed', () => {
    expect(() => githubAtomAdapter.parse(reply('<html><body>hi</body></html>'), source)).toThrow(
      /Malformed releases feed for widgets/,
    );
  });
});
