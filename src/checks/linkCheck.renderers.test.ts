// The link check must read at least as much of a URL as a Markdown renderer does (CON-4).
// It used to stop a bare URL, and a link destination, at the first parenthesis, while renderers
// read on: `https://vendor.example)@evil.test/login` is one link to the host evil.test, and the
// check saw only the collected `https://vendor.example` before the parenthesis.
import { describe, expect, it } from 'vitest';
import {
  INVALID_REFERENCE_PROBLEM,
  MALFORMED_LINK_PROBLEM,
  UNKNOWN_URL_PROBLEM,
  linkCheck,
} from './linkCheck';
import { renderDigest } from '../render/markdown';
import type { Digest } from '../domain/schemas';
import { makeDigest, makeItem } from '../../test/builders';

/** `vendor.example/` is a bare root, the kind of decoy a feed can supply: a prefix of many urls. */
const ROOT = 'https://vendor.example/';
const POST = 'https://example.com/posts/2';
const RELEASE = 'https://github.com/org/repo/releases/tag/v1.2.3';
const QUERY = 'https://www.host.example/path?a=1&b=2#frag';

const items = [
  makeItem({ url: ROOT }),
  makeItem({ url: POST }),
  makeItem({ url: RELEASE }),
  makeItem({ url: QUERY }),
];
const digest = makeDigest(items);
const rendered = renderDigest(digest, { disabledGuards: [] });

const withSummary = (summary: string): Digest => ({
  ...digest,
  items: [{ ...digest.items[0]!, summary }, ...digest.items.slice(1)],
});

/** The same text as a summary (the check reads the digest fields) and as a line of the Markdown. */
const inField = (text: string) => linkCheck(withSummary(text), '', items);
const inMarkdown = (text: string) => linkCheck(digest, `${rendered}\n${text}`, items);
const inCell = (text: string) =>
  linkCheck(digest, `${rendered}\n| [Row](${POST}) | ${text} | Go. |`, items);

const PROBLEM_PREFIXES = [UNKNOWN_URL_PROBLEM, MALFORMED_LINK_PROBLEM, INVALID_REFERENCE_PROBLEM];

function expectRejected(result: ReturnType<typeof linkCheck>): void {
  expect(result.ok).toBe(false);
  expect(result.problems.length).toBeGreaterThan(0);
  for (const problem of result.problems) {
    expect(PROBLEM_PREFIXES.some((prefix) => problem.startsWith(prefix))).toBe(true);
  }
}

describe('a url that a renderer reads past the first parenthesis', () => {
  // Each of these renders (marked, GFM) as a link whose WHATWG host is evil.test or a lookalike.
  it.each([
    [
      'nested parentheses, then userinfo, in a link destination',
      'Details [here](https://vendor.example(a(b))@evil.test/login) now',
    ],
    [
      'a closing parenthesis, then userinfo, in a bare url',
      'Details https://vendor.example)@evil.test/login now',
    ],
    ['nested parentheses after a collected path', '[x](https://example.com/posts/2(a(b)))'],
    [
      'an opening parenthesis, then userinfo, in a bare url',
      'See https://vendor.example(@evil.test/',
    ],
    ['userinfo straight after a collected root', 'See https://vendor.example@evil.test/login now'],
    [
      'a dot after a closing parenthesis (a lookalike host)',
      'See https://vendor.example).evil.test/x',
    ],
    ['an escaped parenthesis in a destination', '[x](https://vendor.example\\)@evil.test/login)'],
    [
      'a parenthesis written as a character reference in a destination',
      '[x](https://vendor.example&#41;@evil.test/login)',
    ],
    ['an escaped parenthesis in a bare url', 'See https://vendor.example\\)@evil.test/login now'],
    ['a pipe after a collected root', 'See https://vendor.example|@evil.test/login now'],
    ['a backtick after a collected root', 'See https://vendor.example`@evil.test/login now'],
    ['a double quote after a collected root', 'See https://vendor.example"@evil.test/login now'],
    [
      'a greater-than sign after a collected root',
      'See https://vendor.example>@evil.test/login now',
    ],
    ['a closing bracket after a collected root', 'See https://vendor.example]@evil.test/login now'],
    [
      'a bare root, a closing bracket and a link to the root, then userinfo',
      'See https://vendor.example](https://vendor.example)@evil.test/login now',
    ],
  ])('rejects %s', (_name, text) => {
    expectRejected(inField(text));
    expectRejected(inMarkdown(text));
    expectRejected(inCell(text));
  });

  it('names the whole run as the unknown url', () => {
    const result = inField('Details https://vendor.example)@evil.test/login now');

    expect(result.problems).toContain(
      `${UNKNOWN_URL_PROBLEM}https://vendor.example)@evil.test/login`,
    );
  });
});

describe('what normalizing drops cannot carry a second link', () => {
  // `normalizeUrl` drops a fragment and `utm_*` values, so these runs equal a collected url. A
  // renderer cuts them at `(`, `*` or `_` and links what follows.
  it.each([
    ['a fragment with a url after a parenthesis', `${POST}#frag:(http://evil.test`],
    ['a fragment with a url after a comma', `${POST}#a,https://evil.test/x`],
    [
      'a tracking parameter with a url after an asterisk',
      `${POST}?utm_source=x*https://evil.test/x`,
    ],
    [
      'a tracking parameter with a url after an underscore',
      `${POST}?utm_source=x_https://evil.test/x`,
    ],
    ['a tracking parameter with a url after a tilde', `${POST}?utm_source=x~https://evil.test/x`],
    ['a tracking parameter with a url after a parenthesis', `${POST}?ref=(https://evil.test/x`],
  ])('rejects %s', (_name, text) => {
    expectRejected(inField(`Read ${text} now`));
    expectRejected(inMarkdown(text));
    expectRejected(inCell(text));
    expectRejected(inMarkdown(`[x](${text})`));
  });

  it.each([
    ['a fragment', `${POST}#fragwww.evil.test`],
    ['a tracking parameter', `${POST}?utm_source=x*www.evil.test`],
    ['a fragment before a scheme-less host', `${POST}#frag //evil.test/x`],
  ])('rejects a scheme-less link in %s', (_name, text) => {
    const result = inMarkdown(text);

    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toContain(MALFORMED_LINK_PROBLEM);
  });

  it('rejects a www. glued to the word before it', () => {
    const result = inField('See evil.test/xwww.evil.test or _www.evil.test or %29www.evil.test');

    expect(result.problems).toContain(`${MALFORMED_LINK_PROBLEM}www.evil.test`);
  });

  it('still accepts a fragment or a tracking parameter that holds no link', () => {
    for (const text of [
      `${POST}#section-2`,
      `${POST}?utm_source=newsletter&utm_medium=email#top`,
    ]) {
      expect(inField(`Read ${text} now`)).toEqual({ ok: true, problems: [] });
    }
  });

  describe('a collected url that holds another url', () => {
    const ARCHIVE = 'https://web.archive.org/web/2020/https://example.com/old';
    const archived = [...items, makeItem({ url: ARCHIVE })];
    const archiveDigest = makeDigest(archived);
    const archiveMarkdown = renderDigest(archiveDigest, { disabledGuards: [] });

    it('passes as collected: in the rendered digest, as a bare url and in parentheses', () => {
      const extra = `${ARCHIVE}\n(see ${ARCHIVE}).\n[t](${ARCHIVE})`;

      expect(archiveMarkdown).toContain(`](${ARCHIVE})`);
      expect(linkCheck(archiveDigest, `${archiveMarkdown}\n${extra}`, archived)).toEqual({
        ok: true,
        problems: [],
      });
    });

    it('is not accepted with an extra fragment or tracking parameter', () => {
      expect(linkCheck(withSummary(`Read ${ARCHIVE}#top now`), '', archived).ok).toBe(false);
      expect(linkCheck(withSummary(`Read ${ARCHIVE}?utm_source=x now`), '', archived).ok).toBe(
        false,
      );
    });
  });
});

describe('a link destination that does not parse cleanly is reported', () => {
  it.each([
    ['junk after an angle-bracket destination', '[x](<https://vendor.example/>@evil.test/login)'],
    ['text after the destination that is not a title', `[x](${POST} @evil.test/login)`],
    ['a second word after the destination', `[x](${POST} extra)`],
    ['a title that is never closed', `[x](${POST} "never closed)`],
    ['an unbalanced opening parenthesis', `[x](${POST}(a)`],
    ['a destination that never closes', `[x](${POST}`],
    ['an angle-bracket destination that never closes', `[x](<${POST}`],
    ['an angle-bracket destination with a second angle bracket', `[x](<${POST}<a>)`],
    ['a title and then more text', `[x](${POST} "t" more)`],
    ['an empty destination', '[x]()'],
    ['nothing but spaces in the parentheses', '[x](   )'],
  ])('rejects %s', (_name, text) => {
    expectRejected(inField(text));
    expectRejected(inMarkdown(text));
  });

  it('reports a destination that is not collected as an unknown url, once', () => {
    const result = inField('[x](https://example.com/posts/2(a(b)))');

    expect(result.problems).toEqual([`${UNKNOWN_URL_PROBLEM}https://example.com/posts/2(a(b))`]);
  });

  it('keeps a reported snippet short, however long the destination is', () => {
    const result = inField(`[x](${POST} ${'junk '.repeat(5_000)})`);

    expect(result.ok).toBe(false);
    for (const problem of result.problems) expect(problem.length).toBeLessThan(300);
  });
});

describe('ordinary links keep passing', () => {
  const rows = (cell: string): string => `| ${cell} | Fixes a bug. | Go. |`;

  it.each([
    ['a release link in a table cell', rows(`[v1.2.3](${RELEASE})`)],
    ['a link with a query string and a fragment', rows(`[t](${QUERY})`)],
    ['the same link with the fragment dropped', rows(`[t](https://www.host.example/path?a=1&b=2)`)],
    ['a link with a title', rows(`[t](${RELEASE} "Release notes")`)],
    ['a link with a single-quoted title', rows(`[t](${RELEASE} 'Release notes')`)],
    ['a link with a parenthesised title', rows(`[t](${RELEASE} (Release notes))`)],
    ['a link with spaces inside the parentheses', rows(`[t]( ${RELEASE} )`)],
    ['an angle-bracket destination', rows(`[t](<${RELEASE}>)`)],
    ['a link whose label is the url', rows(`[${RELEASE}](${RELEASE})`)],
    ['a link whose label holds the url and words', rows(`[see ${RELEASE} now](${RELEASE})`)],
    ['a bold link', rows(`**[t](${RELEASE})**`)],
    ['an italic link', rows(`_[t](${RELEASE})_`)],
    ['a struck-through link', rows(`~~[t](${RELEASE})~~`)],
    ['a link in parentheses', rows(`(see [t](${RELEASE}))`)],
    ['a link followed by a comma and a full stop', rows(`[t](${RELEASE}), then [u](${POST}).`)],
    ['a bare url in a cell', rows(RELEASE)],
    ['a bare url at the end of a sentence', rows(`Read ${RELEASE}.`)],
    ['a bare url in parentheses', rows(`(see ${RELEASE}).`)],
    ['a bare url followed by a colon', rows(`${RELEASE}: fixes a bug`)],
    ['a bare url in quotes', rows(`"${RELEASE}" and '${POST}'`)],
    ['a bare url in a code span', rows(`\`${RELEASE}\``)],
    ['an autolink', rows(`<${RELEASE}>`)],
    ['an autolink in parentheses', rows(`(<${RELEASE}>)`)],
    ['a bare url with the fragment of the collected one', rows(QUERY)],
    ['a bare url with a trailing slash and tracking parameters', rows(`${POST}/?utm_source=x`)],
    ['a bare url followed by an ellipsis and an exclamation mark', rows(`${RELEASE}...!`)],
    ['two bare urls in one cell', rows(`${RELEASE} and ${POST}`)],
    ['a url with a balanced parenthesis, collected', rows('https://example.com/wiki/Foo_(bar)')],
  ])('accepts %s', (_name, line) => {
    const known = [...items, makeItem({ url: 'https://example.com/wiki/Foo_(bar)' })];

    expect(linkCheck(digest, `${rendered}\n${line}`, known)).toEqual({ ok: true, problems: [] });
  });

  it.each([
    ['a plain url', RELEASE],
    ['a url in parentheses', `(see ${RELEASE}).`],
    ['a Markdown link', `[the release](${RELEASE})`],
    ['a Markdown link in parentheses', `(see [the release](${RELEASE})).`],
    ['a query url', QUERY],
  ])('accepts %s in a summary', (_name, summary) => {
    expect(inField(`Read ${summary} first.`)).toEqual({ ok: true, problems: [] });
  });

  it('accepts a digest rendered with a url as the link label', () => {
    const untitled = makeDigest(items.map((item) => ({ ...item, title: ' ' })));
    const markdown = renderDigest(untitled, { disabledGuards: [] });

    expect(markdown).toContain(`[${RELEASE}](${RELEASE})`);
    expect(linkCheck(untitled, markdown, items)).toEqual({ ok: true, problems: [] });
  });
});
