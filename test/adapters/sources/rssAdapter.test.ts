import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Reply } from '../../../src/adapters/sources/http.js';
import { rssAdapter } from '../../../src/adapters/sources/rssAdapter.js';
import type { Source } from '../../../src/core/schemas.js';

const source: Source = { id: 'blog', kind: 'rss', url: 'https://example.com/feed.xml' };
const fixture = (name: string): string =>
  readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), 'utf8');
const reply = (body: string, status = 200): Reply => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(),
  body,
});
const rss = (items: string): string =>
  `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>t</title>${items}</channel></rss>`;

describe('rssAdapter', () => {
  it('is the rss kind and requests the source url once', async () => {
    const urls: string[] = [];
    const replies = await rssAdapter.request(source, {} as never, async (url) => {
      urls.push(url);
      return reply('<rss/>');
    });
    expect(rssAdapter.kind).toBe('rss');
    expect(urls).toEqual(['https://example.com/feed.xml']);
    expect(replies).toHaveLength(1);
  });

  it('throws a status failure for a non-2xx answer', async () => {
    await expect(
      rssAdapter.request(source, {} as never, async () => reply('', 503)),
    ).rejects.toThrow('HTTP 503 fetching blog');
  });

  it('parses RSS 2.0 entries without truncating or stripping the text', () => {
    const entries = rssAdapter.parse(reply(fixture('feeds/rss2.xml')), source);

    expect(entries.length).toBeGreaterThan(0);
    const usable = entries.filter((entry) => entry.url !== '' && entry.publishedAt !== '');
    expect(usable.length).toBeGreaterThan(0);
    for (const entry of usable) {
      expect(entry.url).toMatch(/^https?:/);
      expect(entry.publishedAt).toBeInstanceOf(Date);
    }
    expect(entries.some((e) => e.text.includes('<'))).toBe(true);
  });

  it('prefers content:encoded, then content, then summary, then description', () => {
    const body = rss(`
      <item><title>a</title><link>https://example.com/a</link><pubDate>Mon, 12 Oct 2026 09:00:00 GMT</pubDate>
        <description>short</description><content:encoded><![CDATA[<p>full</p>]]></content:encoded></item>
      <item><title>b</title><link>https://example.com/b</link><pubDate>Mon, 12 Oct 2026 09:00:00 GMT</pubDate>
        <description>only description</description></item>`);

    const [a, b] = rssAdapter.parse(reply(body), source);

    expect(a?.text).toBe('<p>full</p>');
    expect(b?.text).toBe('only description');
  });

  it('prefers the alternate link and the published date of an Atom entry', () => {
    const entries = rssAdapter.parse(reply(fixture('sources/atom-links-and-dates.xml')), source);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.url.startsWith('https://'))).toBe(true);
  });

  it('passes the feed entry id along for feeds that share one link', () => {
    const entries = rssAdapter.parse(reply(fixture('sources/gcp-release-notes.xml')), source);
    expect(entries.every((e) => typeof e.entryId === 'string' && e.entryId !== '')).toBe(true);
  });

  it('gives an entry without a link or a parseable date an empty one, for the pipeline to drop', () => {
    const body = rss(`
      <item><title>no date</title><link>https://example.com/a</link></item>
      <item><title>no link</title><pubDate>Mon, 12 Oct 2026 09:00:00 GMT</pubDate></item>
      <item><title>ok</title><link>https://example.com/ok</link><pubDate>Mon, 12 Oct 2026 09:00:00 GMT</pubDate></item>`);

    const entries = rssAdapter.parse(reply(body), source);
    expect(entries.map((e) => [e.title, e.url === '', e.publishedAt === ''])).toEqual([
      ['no date', false, true],
      ['no link', true, false],
      ['ok', false, false],
    ]);
  });

  it('throws a permanent failure naming the source for malformed XML', () => {
    expect(() => rssAdapter.parse(reply('<rss><channel>'), source)).toThrow(
      'Cannot parse feed blog',
    );
  });

  it('returns no entries for a feed without items', () => {
    expect(rssAdapter.parse(reply(rss('')), source)).toEqual([]);
  });
});
