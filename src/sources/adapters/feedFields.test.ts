import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  alternateLink,
  choicesOf,
  dateTexts,
  entryHtml,
  parseFeedDate,
  rawChoices,
  textOf,
} from './feedFields';

describe('textOf', () => {
  it.each([
    ['a string', 'plain', 'plain'],
    ['an object with #text', { '#text': 'with attrs', '@_type': 'html' }, 'with attrs'],
    ['an object without #text', { '@_type': 'html' }, ''],
    ['an object whose #text is not a string', { '#text': 5 }, ''],
    ['a number', 5, ''],
    ['null', null, ''],
    ['undefined', undefined, ''],
  ])('reads %s', (_label, node, expected) => {
    expect(textOf(node)).toBe(expected);
  });
});

describe('alternateLink', () => {
  it('prefers rel="alternate" over the first link', () => {
    const raw = {
      link: [
        { '@_rel': 'self', '@_href': 'https://example.com/feed.xml' },
        { '@_rel': 'replies', '@_href': 'https://example.com/replies' },
        { '@_rel': 'alternate', '@_type': 'text/html', '@_href': 'https://example.com/post' },
      ],
    };

    expect(alternateLink(raw)).toBe('https://example.com/post');
  });

  it('reads a link without rel as an alternate, as RFC 4287 says', () => {
    const raw = {
      link: [
        { '@_rel': 'enclosure', '@_href': 'https://example.com/file.mp3' },
        { '@_href': ' https://example.com/post ' },
      ],
    };

    expect(alternateLink(raw)).toBe('https://example.com/post');
  });

  it('takes a single link object', () => {
    expect(alternateLink({ link: { '@_href': 'https://example.com/post' } })).toBe(
      'https://example.com/post',
    );
  });

  it('takes the first alternate when there are several', () => {
    const raw = {
      link: [
        { '@_rel': 'alternate', '@_href': 'https://example.com/one' },
        { '@_rel': 'alternate', '@_href': 'https://example.com/two' },
      ],
    };

    expect(alternateLink(raw)).toBe('https://example.com/one');
  });

  it('cleans the link like the library cleans an RSS link: no trackers, no fragment', () => {
    const raw = {
      link: { '@_href': 'https://example.com/p?utm_source=rss&id=7&fbclid=XYZ&mc_eid=1#top' },
    };

    expect(alternateLink(raw)).toBe('https://example.com/p?id=7');
  });

  it('percent-encodes a space, which would break a Markdown link', () => {
    const raw = { link: { '@_href': 'https://example.com/a b' } };

    expect(alternateLink(raw)).toBe('https://example.com/a%20b');
  });

  it.each(['/relative/post', 'mailto:team@example.com', 'ftp://example.com/post', 'nonsense'])(
    'skips an alternate that is not an absolute http(s) URL (%s) and takes the next',
    (href) => {
      const raw = {
        link: [
          { '@_rel': 'alternate', '@_href': href },
          { '@_rel': 'alternate', '@_href': 'https://example.com/post' },
        ],
      };

      expect(alternateLink(raw)).toBe('https://example.com/post');
    },
  );

  it('has no opinion when no alternate is a usable URL', () => {
    expect(alternateLink({ link: { '@_href': '/relative' } })).toBeUndefined();
  });

  it('has no opinion when no link is an alternate', () => {
    const raw = { link: [{ '@_rel': 'self', '@_href': 'https://example.com/feed.xml' }] };

    expect(alternateLink(raw)).toBeUndefined();
  });

  it.each([
    ['an RSS text link', { link: 'https://example.com/post' }],
    ['no link', {}],
    ['an href that is not text', { link: { '@_href': 7 } }],
    ['an empty href', { link: { '@_href': '  ' } }],
    ['a list with odd members', { link: [null, 4, 'text'] }],
  ])('has no opinion on %s, which the library already reads', (_label, raw) => {
    expect(alternateLink(raw)).toBeUndefined();
  });
});

describe('dateTexts', () => {
  it('lists published before updated', () => {
    const raw = { updated: '2026-10-16T12:00:00Z', published: '2026-10-10T10:00:00Z' };

    expect(dateTexts(raw)).toEqual(['2026-10-10T10:00:00Z', '2026-10-16T12:00:00Z']);
  });

  it('reads RSS pubDate and Dublin Core dates', () => {
    const raw = { 'dc:date': '2026-10-16', pubDate: 'Fri, 16 Oct 2026 10:00:00 GMT' };

    expect(dateTexts(raw)).toEqual(['Fri, 16 Oct 2026 10:00:00 GMT', '2026-10-16']);
  });

  it('reads the older Atom 0.3 names after the current ones', () => {
    expect(dateTexts({ modified: 'm', issued: 'i', updated: 'u' })).toEqual(['i', 'u', 'm']);
  });

  it('reads text inside an element with attributes and skips blanks', () => {
    const raw = { published: { '#text': '2026-10-10', '@_x': 'y' }, updated: '  ', pubDate: 7 };

    expect(dateTexts(raw)).toEqual(['2026-10-10']);
  });

  it('is empty for an entry without dates', () => {
    expect(dateTexts({ title: 'x' })).toEqual([]);
  });
});

describe('entryHtml', () => {
  it.each([
    ['an RSS content:encoded', { description: '<p>d</p>', 'content:encoded': 'c' }, 'c'],
    ['an Atom content', { summary: { '#text': 's', '@_type': 'html' }, content: 'c' }, 'c'],
    ['RSS content:encoded', { 'content:encoded': '<p>full</p>' }, '<p>full</p>'],
    ['Atom content', { content: { '#text': 'body', '@_type': 'html' } }, 'body'],
  ])('reads %s', (_label, raw, expected) => {
    expect(entryHtml(raw)).toBe(expected);
  });

  it('is empty when the entry has no text', () => {
    expect(entryHtml({ title: 'x' })).toBe('');
  });
});

describe('rawChoices and choicesOf', () => {
  it('round-trips through a library entry', () => {
    const raw = {
      link: [{ '@_rel': 'alternate', '@_href': 'https://example.com/post' }],
      published: '2026-10-10T10:00:00Z',
      summary: 'text',
    };

    const entry = { id: 'e', ...rawChoices(raw) };

    expect(choicesOf(entry)).toEqual({
      alternateUrl: 'https://example.com/post',
      dateTexts: ['2026-10-10T10:00:00Z'],
      html: 'text',
    });
  });

  it('reads nothing from an entry the library produced without our fields', () => {
    expect(choicesOf({ id: 'e', link: 'https://example.com/post' })).toEqual({});
  });

  it('ignores fields of the wrong type', () => {
    const entry = { id: 'e', alternateUrl: 4, dateTexts: 'nope', html: null };

    expect(choicesOf(entry)).toEqual({});
  });

  it('keeps only the text members of a date list', () => {
    expect(choicesOf({ id: 'e', dateTexts: ['2026-10-10', 4, null, '2026-10-11'] })).toEqual({
      dateTexts: ['2026-10-10', '2026-10-11'],
    });
  });
});

describe('parseFeedDate', () => {
  const originalTz = process.env.TZ;

  // A zone far from UTC, so a date read in local time cannot pass by luck.
  beforeAll(() => {
    process.env.TZ = 'America/Los_Angeles';
  });

  afterAll(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it('runs in a zone that is not UTC', () => {
    expect(new Date('2026-10-12T08:00:00').getTimezoneOffset()).not.toBe(0);
  });

  it.each([
    ['ISO with Z', '2026-10-12T08:00:00Z', '2026-10-12T08:00:00.000Z'],
    ['ISO with a positive offset', '2026-10-12T10:00:00+02:00', '2026-10-12T08:00:00.000Z'],
    ['ISO with a negative offset', '2026-10-12T02:00:00-06:00', '2026-10-12T08:00:00.000Z'],
    ['ISO with a compact offset', '2026-10-12T10:00:00+0200', '2026-10-12T08:00:00.000Z'],
    ['ISO date only', '2026-10-12', '2026-10-12T00:00:00.000Z'],
    ['RFC 822 with GMT', 'Mon, 12 Oct 2026 08:00:00 GMT', '2026-10-12T08:00:00.000Z'],
    ['RFC 822 with an offset', 'Mon, 12 Oct 2026 10:00:00 +0200', '2026-10-12T08:00:00.000Z'],
    ['RFC 822 with a zone name', 'Mon, 12 Oct 2026 04:00:00 EDT', '2026-10-12T08:00:00.000Z'],
  ])('keeps the zone of %s', (_label, text, expected) => {
    expect(parseFeedDate(text)?.toISOString()).toBe(expected);
  });

  it.each([
    ['ISO without a zone', '2026-10-12T08:00:00'],
    ['ISO with a space', '2026-10-12 08:00:00'],
    ['ISO without seconds', '2026-10-12 08:00'],
    ['ISO with fractions', '2026-10-12T08:00:00.000'],
    ['RFC 822 without a zone', 'Mon, 12 Oct 2026 08:00:00'],
    ['RFC 822 without seconds', 'Mon, 12 Oct 2026 08:00'],
    ['a long date', 'October 12, 2026 08:00:00'],
  ])('reads %s as UTC', (_label, text) => {
    expect(parseFeedDate(text)?.toISOString()).toBe('2026-10-12T08:00:00.000Z');
  });

  it.each([
    ['a 12-hour clock with PM', 'Oct 12, 2026 8:00 PM', '2026-10-12T20:00:00.000Z'],
    ['a 12-hour clock with seconds and am', 'Oct 12, 2026 8:00:00 am', '2026-10-12T08:00:00.000Z'],
    ['a slash date', '2026/10/12', '2026-10-12T00:00:00.000Z'],
    ['a slash date with a time', '2026/10/12 08:00:00', '2026-10-12T08:00:00.000Z'],
  ])('reads %s as UTC', (_label, text, expected) => {
    expect(parseFeedDate(text)?.toISOString()).toBe(expected);
  });

  it('keeps an explicit zone after a 12-hour clock', () => {
    expect(parseFeedDate('Oct 12, 2026 10:00 PM +0200')?.toISOString()).toBe(
      '2026-10-12T20:00:00.000Z',
    );
  });

  it('reads an RFC 822 date without a time as midnight UTC', () => {
    expect(parseFeedDate('Mon, 12 Oct 2026')?.toISOString()).toBe('2026-10-12T00:00:00.000Z');
  });

  it('trims the text', () => {
    expect(parseFeedDate('  2026-10-12T08:00:00Z \n')?.toISOString()).toBe(
      '2026-10-12T08:00:00.000Z',
    );
  });

  it.each(['', '   ', 'not a date', '2026-13-45', 'Mon, 99 Foo 2026 08:00:00'])(
    'rejects %j',
    (text) => {
      expect(parseFeedDate(text)).toBeUndefined();
    },
  );
});

describe('typographic entities in entry markup', () => {
  it('decodes the named punctuation a full body uses, and leaves markup entities alone', () => {
    expect(
      entryHtml({
        'content:encoded': 'don&rsquo;t &ldquo;stop&rdquo;&hellip; &lt;T&gt; &amp; &unknown;',
      }),
    ).toBe('don’t “stop”… &lt;T&gt; &amp; &unknown;');
  });
});
