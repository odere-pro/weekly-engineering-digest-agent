// `href=` and `src=` are read as attributes only inside an HTML tag. In a query string they are
// ordinary parameters: a collected `https://example.com/post?src=rss` used to be reported as the
// unknown url `rss)`, so any such link blocked every draft and the fallback.
import { describe, expect, it } from 'vitest';
import { UNKNOWN_URL_PROBLEM, linkCheck } from './linkCheck';
import { renderDigest } from '../render/markdown';
import type { Digest } from '../domain/schemas';
import { makeDigest, makeItem } from '../../test/builders';

const SRC_URL = 'https://example.com/post?src=rss';
const HREF_URL = 'https://example.com/list?page=2&href=x';
const BOTH_URL = 'https://example.com/go?a=1&src=a&href=b';
const items = [
  makeItem({ url: SRC_URL }),
  makeItem({ url: HREF_URL }),
  makeItem({ url: BOTH_URL }),
];
const digest = makeDigest(items);
const rendered = renderDigest(digest, { disabledGuards: [] });

const withSummary = (summary: string): Digest => ({
  ...digest,
  items: [{ ...digest.items[0]!, summary }, ...digest.items.slice(1)],
});

describe('src= and href= in the query of a collected url', () => {
  it('passes the digest the renderer writes for such urls', () => {
    expect(rendered).toContain(`](${SRC_URL})`);
    expect(linkCheck(digest, rendered, items)).toEqual({ ok: true, problems: [] });
  });

  it.each([SRC_URL, HREF_URL, BOTH_URL])('passes %s as a Markdown destination', (url) => {
    const markdown = `${rendered}\n| [t](${url}) | x |`;

    expect(linkCheck(digest, markdown, items)).toEqual({ ok: true, problems: [] });
  });

  it.each([SRC_URL, HREF_URL, BOTH_URL])('passes %s as a bare url', (url) => {
    const markdown = `${rendered}\n| ${url} | x |\nRead ${url}.`;

    expect(linkCheck(digest, markdown, items)).toEqual({ ok: true, problems: [] });
    expect(linkCheck(withSummary(`Read ${url} first.`), '', items)).toEqual({
      ok: true,
      problems: [],
    });
  });

  it.each([SRC_URL, HREF_URL, BOTH_URL])('passes %s inside parentheses', (url) => {
    const markdown = `${rendered}\n(see ${url}) and (<${url}>) and ([t](${url})).`;

    expect(linkCheck(digest, markdown, items)).toEqual({ ok: true, problems: [] });
    expect(linkCheck(withSummary(`Read it (${url}).`), '', items)).toEqual({
      ok: true,
      problems: [],
    });
  });

  it('still rejects an uncollected url with the same parameters', () => {
    const result = linkCheck(withSummary('Read https://evil.example/post?src=rss now.'), '', items);

    expect(result.problems).toEqual([`${UNKNOWN_URL_PROBLEM}https://evil.example/post?src=rss`]);
  });
});

describe('src= and href= inside an HTML tag are still read', () => {
  it.each([
    ['an anchor with an unquoted href', '<a href=https://evil.example/x>x</a>'],
    ['an anchor with a quoted href', '<a href="https://evil.example/x">x</a>'],
    ['an anchor with a single-quoted href', "<a href='https://evil.example/x'>x</a>"],
    ['an image with a src', '<img src=https://evil.example/x>'],
    ['an image with other attributes first', '<img alt="a" width=2 src=https://evil.example/x>'],
    ['upper-case names', '<A HREF="https://evil.example/x">x</A>'],
    ['spaces around the equals sign', '<a href = "https://evil.example/x">x</a>'],
    ['a slash instead of a space', '<img/src=https://evil.example/x>'],
    ['a line break before the attribute', '<a\nhref="https://evil.example/x">x</a>'],
    [
      'a tag written with character references',
      '&lt;a href="https://evil.example/x"&gt;x&lt;/a&gt;',
    ],
    ['a tag with a hyphenated name', '<my-tag href=https://evil.example/x>'],
  ])('rejects %s', (_name, html) => {
    const withHtml = linkCheck(withSummary(html), '', items);
    const inMarkdown = linkCheck(digest, `${rendered}\n${html}`, items);

    for (const result of [withHtml, inMarkdown]) {
      expect(result.ok).toBe(false);
      expect(result.problems.join('\n')).toContain('https://evil.example/x');
    }
  });

  it.each([
    ['a scheme-less href', '<a href=evil.example/x>x</a>', 'evil.example/x'],
    ['a javascript href', '<a href="javascript:alert(1)">x</a>', 'javascript:alert(1)'],
    ['a relative src', '<img src=/local/x.png>', '/local/x.png'],
  ])('rejects %s as an unknown url', (_name, html, url) => {
    expect(linkCheck(withSummary(html), '', items).problems).toContain(
      `${UNKNOWN_URL_PROBLEM}${url}`,
    );
  });

  it('rejects an attribute that follows a collected url with src= in its query', () => {
    const html = `<a href="${SRC_URL}" src=https://evil.example/x>x</a>`;

    expect(linkCheck(withSummary(html), '', items).problems).toContain(
      `${UNKNOWN_URL_PROBLEM}https://evil.example/x`,
    );
  });
});

describe('the attribute search on hostile text', () => {
  const BUDGET_MS = 1_000;
  const SIZE = 64 * 1024;
  const repeated = (unit: string): string => unit.repeat(Math.ceil(SIZE / unit.length));

  it.each([
    ['tag openers with no end', repeated('<a ')],
    ['tag openers and attribute names', repeated('<a href ')],
    ['attribute names with long runs of spaces', repeated(`href${' '.repeat(200)}`)],
    ['an attribute name and a very long run of spaces', `<a href${' '.repeat(SIZE)}`],
    ['equals signs and quotes', repeated('<a href=" src=\'')],
    ['a tag with a very long unquoted value', `<a href=${'x'.repeat(SIZE)}`],
    ['many short tags', repeated('<a href=x>')],
  ])('stays fast on %s', (_name, text) => {
    const started = performance.now();

    linkCheck(withSummary(text), text, items);

    expect(performance.now() - started).toBeLessThan(BUDGET_MS);
  });
});
