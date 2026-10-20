import { describe, expect, it } from 'vitest';
import { canonicalLink } from './canonicalLink';

const BASE = 'https://example.com';

describe('canonicalLink', () => {
  it.each([
    `${BASE}/`,
    `${BASE}/blog/2026/10/kubernetes-1-35-released`,
    `${BASE}/a/b.html?id=1&lang=en#section-1.2`,
    `${BASE}/a?x=1&y=2&z=a+b`,
    `${BASE}/releases/tag/v1.2.3-rc.1`,
    `${BASE}/releases/tag/v1.0.0%2Bbuild.5`,
    `${BASE}/a%29b/%28c%29`,
    `${BASE}/~user/notes_2026/`,
    `${BASE}/a/b;jsessionid=1,2/c`,
    `${BASE}/p?q=a,b;c:d!e`,
    `${BASE}/p?a&b=1&c`,
    `${BASE}/caf\u00e9/\u4e2d\u6587`,
    `${BASE}:8443/a`,
    `http://EXAMPLE.com/A?B=C`,
    `${BASE}//a///b/`,
    `${BASE}/@user/post`,
    `${BASE}/a?u=//other.test/x`,
    `${BASE}/a=b/c`,
  ])('leaves the ordinary link %s byte for byte', (link) => {
    expect(canonicalLink(link)).toBe(link);
  });

  it.each([
    ['a round bracket', `${BASE}/a(b)c`, `${BASE}/a%28b%29c`],
    ['an unbalanced closing bracket', `${BASE}/a)b`, `${BASE}/a%29b`],
    ['an unbalanced opening bracket', `${BASE}/a(b`, `${BASE}/a%28b`],
    ['nested brackets', `${BASE}/a(b(c))`, `${BASE}/a%28b%28c%29%29`],
    ['a bracket in the query', `${BASE}/?q=(`, `${BASE}/?q=%28`],
    ['a bracket in the fragment', `${BASE}/#(a`, `${BASE}/#%28a`],
    ['square brackets', `${BASE}/a[b]c`, `${BASE}/a%5Bb%5Dc`],
    ['angle brackets', `${BASE}/a<b>`, `${BASE}/a%3Cb%3E`],
    ['an apostrophe', `${BASE}/blog/it's-here`, `${BASE}/blog/it%27s-here`],
    ['a double quote', `${BASE}/a"b`, `${BASE}/a%22b`],
    ['a backtick', `${BASE}/a\`b`, `${BASE}/a%60b`],
    ['a pipe', `${BASE}/a|b`, `${BASE}/a%7Cb`],
    ['a backslash', `${BASE}/a\\b`, `${BASE}/a%5Cb`],
    ['a space', `${BASE}/a b`, `${BASE}/a%20b`],
    ['a tab and a line break', `${BASE}/a\tb\nc`, `${BASE}/a%09b%0Ac`],
    ['a no-break space', `${BASE}/a\u00a0b`, `${BASE}/a%C2%A0b`],
    ['a zero-width space', `${BASE}/a\u200bb`, `${BASE}/a%E2%80%8Bb`],
    ['a bidi override', `${BASE}/a\u202eb`, `${BASE}/a%E2%80%AEb`],
    ['a tag character', `${BASE}/a\u{E0041}b`, `${BASE}/a%F3%A0%81%81b`],
    ['a control character', `${BASE}/a\u0007b`, `${BASE}/a%07b`],
  ])('percent-encodes %s', (_name, link, expected) => {
    expect(canonicalLink(link)).toBe(expected);
  });

  it.each([
    ['a double-encoded ampersand', `${BASE}/p?id=1&amp;lang=en`, `${BASE}/p?id=1&lang=en`],
    ['an upper-case one', `${BASE}/p?id=1&AMP;lang=en`, `${BASE}/p?id=1&lang=en`],
    ['two of them', `${BASE}/p?a=1&amp;b=2&amp;c=3`, `${BASE}/p?a=1&b=2&c=3`],
  ])('reads %s as the ampersand it stands for', (_name, link, expected) => {
    expect(canonicalLink(link)).toBe(expected);
  });

  it.each([
    ['a named reference', `${BASE}/a&lt;b`, `${BASE}/a%26lt;b`],
    ['a decimal reference', `${BASE}/a&#41;`, `${BASE}/a%26#41%3B`],
    ['a hexadecimal reference', `${BASE}/a&#x29;b`, `${BASE}/a%26#x29;b`],
    [
      'a reference that names no character',
      `${BASE}/a&#99999999999;b`,
      `${BASE}/a%26#99999999999;b`,
    ],
    ['a reference left by the first decode', `${BASE}/a&amp;lt;b`, `${BASE}/a%26lt;b`],
    ['a double-encoded one twice over', `${BASE}/a&amp;amp;b`, `${BASE}/a%26amp;b`],
  ])('keeps %s from being read as a character reference', (_name, link, expected) => {
    expect(canonicalLink(link)).toBe(expected);
  });

  it.each([
    [`${BASE}/a&b=1`, `${BASE}/a&b=1`],
    [`${BASE}/a?x=1&y=2`, `${BASE}/a?x=1&y=2`],
    [`${BASE}/a&b;c`, `${BASE}/a%26b;c`],
    [`${BASE}/a&b`, `${BASE}/a&b`],
    [`${BASE}/a&;b`, `${BASE}/a&;b`],
    [`${BASE}/a&#;b`, `${BASE}/a&#;b`],
  ])('treats an ampersand as a reference only when one follows: %s', (link, expected) => {
    expect(canonicalLink(link)).toBe(expected);
  });

  it.each([
    ['a full stop', `${BASE}/a.`, `${BASE}/a%2E`],
    ['a comma and a full stop', `${BASE}/a,b.`, `${BASE}/a,b%2E`],
    ['an exclamation mark', `${BASE}/a!`, `${BASE}/a%21`],
    ['a colon', `${BASE}/a:`, `${BASE}/a%3A`],
    ['a semicolon', `${BASE}/a;`, `${BASE}/a%3B`],
    ['an asterisk', `${BASE}/a*`, `${BASE}/a%2A`],
    ['an underscore', `${BASE}/a_`, `${BASE}/a%5F`],
    ['a tilde', `${BASE}/a~`, `${BASE}/a%7E`],
    ['a run of them', `${BASE}/a.,;:!`, `${BASE}/a%2E%2C%3B%3A%21`],
    ['one at the end of a query', `${BASE}/a?x=1.`, `${BASE}/a?x=1%2E`],
    ['one at the end of a fragment', `${BASE}/a#top.`, `${BASE}/a#top%2E`],
    ['one before an empty query', `${BASE}/a.?`, `${BASE}/a%2E`],
  ])('percent-encodes the punctuation that ends a link: %s', (_name, link, expected) => {
    expect(canonicalLink(link)).toBe(expected);
  });

  it.each([
    [`${BASE}/a?`, `${BASE}/a`],
    [`${BASE}/a#`, `${BASE}/a`],
    [`${BASE}/a?#`, `${BASE}/a`],
    [`${BASE}/a/?`, `${BASE}/a/`],
    [`${BASE}/a?x=1#`, `${BASE}/a?x=1`],
    [`${BASE}?`, BASE],
  ])('drops an empty query or fragment at the end: %s', (link, expected) => {
    expect(canonicalLink(link)).toBe(expected);
  });

  it('is idempotent, so a link that went through twice does not change again', () => {
    const links = [
      `${BASE}/a(b)c.`,
      `${BASE}/p?id=1&amp;lang=en&amp;amp;x=1`,
      `${BASE}/a&#41;&lt;!`,
      `${BASE}/a b\u200b|c\\d?#`,
      `${BASE}/blog/it's-here.`,
    ];
    for (const link of links) {
      const once = canonicalLink(link);
      expect(canonicalLink(once)).toBe(once);
    }
  });

  it('leaves no character that a Markdown link or the link check reads as structure', () => {
    const hostile = canonicalLink(`${BASE}/a(b)[c]<d>'e"f\`g|h\\i j&amp;k&lt;l.`);
    expect(hostile).not.toMatch(/[()[\]<>'"`|\\\s]/);
    expect(hostile).not.toMatch(/&[#a-z0-9]+;/i);
    expect(hostile).not.toMatch(/[.,;:!*_~?#]$/);
  });

  it('reads a long run of punctuation in bounded time', () => {
    const started = Date.now();
    canonicalLink(`${BASE}/a${'?'.repeat(100_000)}b${'.'.repeat(100_000)}${'&'.repeat(100_000)}`);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
