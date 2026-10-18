import { describe, expect, it } from 'vitest';
import { linkCheck } from './linkCheck';
import { renderDigest } from '../render/markdown';
import { makeDigest, makeItem } from '../../test/builders';

const items = [makeItem(), makeItem(), makeItem()];

describe('linkCheck', () => {
  it('passes a clean digest', () => {
    const digest = makeDigest(items);
    const md = renderDigest(digest, { disabledGuards: [] });

    expect(linkCheck(digest, md, items)).toEqual({ ok: true, problems: [] });
  });

  it('flags an unknown URL in a summary', () => {
    const digest = makeDigest(items);
    const bad = { ...digest.items[0]!, summary: 'See https://evil.example.org/x for more.' };
    const d = { ...digest, items: [bad, ...digest.items.slice(1)] };
    const result = linkCheck(d, renderDigest(d, { disabledGuards: [] }), items);

    expect(result.ok).toBe(false);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain('https://evil.example.org/x');
  });

  it('flags an unknown URL that appears only in the markdown', () => {
    const digest = makeDigest(items);
    const md = `${renderDigest(digest, { disabledGuards: [] })}\n[more](https://other.example.net/a)\nhttps://bare.example.net/b`;
    const result = linkCheck(digest, md, items);

    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toContain('https://other.example.net/a');
    expect(result.problems.join('\n')).toContain('https://bare.example.net/b');
  });

  it('is tolerant of utm params, fragments and trailing punctuation', () => {
    const digest = makeDigest(items);
    const url = `${items[0]!.url}?utm_source=x#top`;
    const d = { ...digest, intro: `Read ${url}.` };

    expect(linkCheck(d, `${renderDigest(d, { disabledGuards: [] })}\n(${url})`, items).ok).toBe(
      true,
    );
  });

  it('flags a digest item url that is not a collected item', () => {
    const digest = makeDigest(items);
    const d = { ...digest, items: [{ ...digest.items[0]!, url: 'https://unknown.example.com/p' }] };

    expect(linkCheck(d, '', items).ok).toBe(false);
  });
});

describe('linkCheck bypass attempts', () => {
  const digest = makeDigest(items);
  const md = (extra: string): string => `${renderDigest(digest, { disabledGuards: [] })}\n${extra}`;

  it.each([
    '[x](https:/evil.com)',
    '[x](https:evil.com)',
    '[x](https:\\\\evil.com)',
    '[x](//evil.com)',
    '<a href=//evil.com>x</a>',
    'see www.evil.com',
    '[x](evil.com)',
    '[x](&#104;ttps://evil.com)',
    '[x](javascript:alert(1))',
  ])('rejects %s', (extra) => {
    expect(linkCheck(digest, md(extra), items).ok).toBe(false);
  });

  it('rejects an item url that only starts with a known url', () => {
    const url = `${items[0]!.url})[click](javascript:alert(1)`;
    const d = { ...digest, items: [{ ...digest.items[0]!, url }, ...digest.items.slice(1)] };

    expect(linkCheck(d, '', items).ok).toBe(false);
  });

  it('accepts a known url with parentheses and trailing underscore', () => {
    const odd = [makeItem({ url: 'https://example.com/wiki/Foo_(bar)' }), ...items.slice(1)];
    const d = makeDigest(odd);

    expect(linkCheck(d, renderDigest(d, { disabledGuards: [] }), odd).ok).toBe(true);
  });
});

describe('linkCheck character references outside the Unicode range (F31)', () => {
  const digest = makeDigest(items);
  const clean = renderDigest(digest, { disabledGuards: [] });
  const withSummary = (summary: string) => ({
    ...digest,
    items: [{ ...digest.items[0]!, summary }, ...digest.items.slice(1)],
  });

  it.each([
    ['a hex reference one past the last code point', '&#x110000;'],
    ['a decimal reference one past the last code point', '&#1114112;'],
    ['an upper-case hex reference', '&#X110000;'],
    ['a hex reference with hundreds of digits', `&#x${'f'.repeat(400)};`],
    ['a decimal reference with hundreds of digits', `&#${'9'.repeat(400)};`],
  ])('rejects %s in a summary instead of throwing', (_name, reference) => {
    const d = withSummary(`Odd text ${reference} here.`);

    const result = linkCheck(d, renderDigest(d, { disabledGuards: [] }), items);

    expect(result.ok).toBe(false);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatch(/invalid character reference/i);
  });

  it('rejects an invalid reference that appears only in the markdown', () => {
    const result = linkCheck(digest, `${clean}\nBroken &#x110000; entity`, items);

    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toMatch(/invalid character reference/i);
  });

  it('rejects an invalid reference in the headline and in an item title', () => {
    const d = {
      ...digest,
      headline: 'Headline &#x110000;',
      items: [{ ...digest.items[0]!, title: 'Title &#1114112;' }, ...digest.items.slice(1)],
    };

    expect(linkCheck(d, '', items).ok).toBe(false);
  });

  it('reports the same invalid reference once and keeps the problem short', () => {
    const long = `&#x${'f'.repeat(5_000)};`;
    const d = withSummary(`${long} and ${long}`);

    const result = linkCheck(d, renderDigest(d, { disabledGuards: [] }), items);

    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]!.length).toBeLessThan(200);
  });

  it('still finds an unknown url next to an invalid reference', () => {
    const d = withSummary('Bad &#x110000; then https://evil.example.org/x');

    const result = linkCheck(d, '', items);

    expect(result.problems.join('\n')).toContain('https://evil.example.org/x');
    expect(result.problems.join('\n')).toMatch(/invalid character reference/i);
  });

  it('still decodes valid references, including the last code point', () => {
    const d = withSummary('Fine &#x10FFFF; and &#128512; and &#x3a; text.');

    expect(linkCheck(d, renderDigest(d, { disabledGuards: [] }), items).ok).toBe(true);
  });

  it('still unmasks a url hidden behind named entities and leaves unknown ones alone', () => {
    const hidden = withSummary('See https&colon;&sol;&sol;evil.example.org/x &bogus; now.');

    const result = linkCheck(hidden, '', items);

    expect(result.problems.join('\n')).toContain('https://evil.example.org/x');
    expect(result.problems.join('\n')).not.toMatch(/invalid character reference/i);
  });

  it.each(['&#104;', '&#x68;', '&#X68;'])(
    'still unmasks a url hidden behind the valid reference %s',
    (reference) => {
      const d = withSummary(`See ${reference}ttps://evil.example.org/x now.`);

      const result = linkCheck(d, '', items);

      expect(result.problems.join('\n')).toContain('https://evil.example.org/x');
    },
  );
});

describe('linkCheck on hostile text', () => {
  it('stays fast on a url followed by tens of thousands of dots and other punctuation', () => {
    const digest = makeDigest(items);
    const hostile = {
      ...digest,
      intro: `See https://evil.example.org/${'.'.repeat(60_000)}x and https://evil.example.org/${'!?'.repeat(30_000)}x`,
    };
    const started = performance.now();

    const result = linkCheck(hostile, '', items);

    expect(performance.now() - started).toBeLessThan(1_000);
    expect(result.ok).toBe(false);
  });

  it('still strips trailing punctuation from a known url', () => {
    const digest = makeDigest(items);
    const d = { ...digest, intro: `Read ${items[0]!.url}...!?` };

    expect(linkCheck(d, '', items).ok).toBe(true);
  });
});
