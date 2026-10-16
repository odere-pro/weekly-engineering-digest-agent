import { describe, expect, it } from 'vitest';
import { linkCheck } from '../../../src/core/checks/linkCheck.js';
import { renderDigest } from '../../../src/core/render.js';
import { makeDigest, makeItem } from '../../builders.js';

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
