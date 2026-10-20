import { describe, expect, it } from 'vitest';
import { runDigest } from '../../src/digest/runDigest';
import { ExitCode, type Source } from '../../src/domain/schemas';
import { createRssFetcher } from '../../src/sources/adapters/rss';
import type { FetchWindow } from '../../src/sources/SourceFetcher';
import { defaultBody, sentDigests, setup } from '../../src/digest/__fixtures__/runKit';

// A feed link with a character that Markdown or the link check reads as structure used to make
// every writer draft, and the template fallback too, fail the link check: the week ended
// `blocked` and nothing was sent. The link is now made safe where the item is built
// (`canonicalLink`), so these weeks run the whole chain on a feed as the real RSS fetcher reads it.

const SOURCE: Source = { id: 'example-feed', kind: 'rss', url: 'https://example.com/feed.xml' };
const WINDOW: FetchWindow = {
  since: new Date('2026-10-09T08:00:00Z'),
  until: new Date('2026-10-16T08:00:00Z'),
  maxItems: 20,
};
const PUBLISHED = 'Wed, 14 Oct 2026 09:00:00 GMT';
const ORDINARY = [1, 2, 3, 4].map((n) => `https://example.com/posts/${n}`);

/** The link goes in as CDATA, so what the feed parser makes of it is the only decoding. */
function feedWith(links: readonly string[]): string {
  const items = links.map(
    (link, index) =>
      `<item><title>Runner ${index + 1}.0 ships</title><link><![CDATA[${link}]]></link>` +
      `<pubDate>${PUBLISHED}</pubDate><description>Runner ${index + 1}.0 ships with faster builds.</description></item>`,
  );
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>${items.join('')}</channel></rss>`;
}

/** The link as the feed text holds it and the link the item must keep. */
const HOSTILE: readonly (readonly [string, string, string])[] = [
  ['an apostrophe', "https://example.com/blog/it's-here", 'https://example.com/blog/it%27s-here'],
  ['an unbalanced closing bracket', 'https://example.com/a)b', 'https://example.com/a%29b'],
  ['an unbalanced opening bracket', 'https://example.com/a(b', 'https://example.com/a%28b'],
  ['nested brackets', 'https://example.com/a(b(c))', 'https://example.com/a%28b%28c%29%29'],
  ['a square bracket', 'https://example.com/a[b', 'https://example.com/a%5Bb'],
  ['a closing square bracket', 'https://example.com/a]b', 'https://example.com/a%5Db'],
  ['a final full stop', 'https://example.com/a.', 'https://example.com/a%2E'],
  ['a comma and a final full stop', 'https://example.com/a,b.', 'https://example.com/a,b%2E'],
  ['a final exclamation mark', 'https://example.com/a!', 'https://example.com/a%21'],
  ['a final colon', 'https://example.com/a:', 'https://example.com/a%3A'],
  ['a final semicolon', 'https://example.com/a;', 'https://example.com/a%3B'],
  ['a space', 'https://example.com/a b', 'https://example.com/a%20b'],
];

/** A writer that cites a link nobody collected: every draft fails the link check. */
const writerWithUnknownLink: Parameters<typeof setup>[0] = {
  draft: (_writer, items) => {
    const body = defaultBody(items);
    return {
      ...body,
      items: body.items.map((item) => ({
        ...item,
        summary: `${item.summary} See https://unknown.example/post`,
      })),
    };
  },
};

async function weekOf(link: string, scenario: Parameters<typeof setup>[0] = {}) {
  const links = [...ORDINARY.slice(0, 2), link, ...ORDINARY.slice(2)];
  const fetcher = createRssFetcher({ fetch: async () => new Response(feedWith(links)) });
  const items = await fetcher.fetch(SOURCE, WINDOW);
  const h = setup({ ...scenario, items });
  const result = await runDigest({ ...h.deps, fetchers: { ...h.deps.fetchers, rss: fetcher } }, {});
  return { items, h, result };
}

describe.each([
  ['a writer draft', {}, false],
  ['the template fallback', writerWithUnknownLink, true],
])('a feed link with a Markdown-structural character, sent as %s', (_mode, scenario, fallback) => {
  it.each(HOSTILE)(
    'sends the week with %s in a link, under its canonical form',
    async (_name, feedLink, canonical) => {
      const { items, h, result } = await weekOf(feedLink, scenario);

      expect(items.map((item) => item.url)).toContain(canonical);
      expect(result.record.status).toBe('sent');
      expect(result.exitCode).toBe(ExitCode.Sent);
      expect(Boolean(result.record.fallback)).toBe(fallback);
      const messages = sentDigests(h);
      expect(messages).toHaveLength(2);
      for (const message of messages) {
        expect(message.markdown).toContain(`](${canonical})`);
        expect(JSON.stringify(message.view)).toContain(JSON.stringify(canonical));
      }
      expect(result.record.sentUrls).toContain(canonical);
    },
  );
});

describe('a feed whose links are all ordinary', () => {
  it('keeps every link as the feed wrote it', async () => {
    const { items, result } = await weekOf('https://example.com/posts/5');

    expect(items.map((item) => item.url).sort()).toEqual(
      [...ORDINARY, 'https://example.com/posts/5'].sort(),
    );
    expect(result.record.status).toBe('sent');
  });
});
