// Angle brackets in model or feed text must stay text in digest.md (CON-3). An RSS title
// `&lt;svg onload=alert(1)&gt; Release 1` arrives as `<svg onload=alert(1)> Release 1`; written
// raw, an HTML-capable Markdown viewer would run it. The email, HTML and Slack channels escape
// already; `.md` backslash-escapes `<` and `>`, which CommonMark renders as the plain character.
import { describe, expect, it } from 'vitest';
import { linkCheck } from '../checks/linkCheck';
import { formatCheck } from '../checks/formatCheck';
import { readSavedDigest, readSavedView, renderDigest, renderView } from './markdown';
import type { DigestView } from './digestView';
import type { Digest, DigestItem } from '../domain/schemas';
import { makeDigest, makeDigestItem, makeItem } from '../../test/builders';
import { splitCells } from './__fixtures__/render/cells';

const NONE = { disabledGuards: [] } as const;

/** A `<` or `>` that a renderer reads as markup: not backslash-escaped (an even run before it). */
const LIVE_ANGLE = /(?<!\\)(?:\\\\)*[<>]/;

const TAGS = [
  '<svg onload=alert(1)> Release 1',
  '<img src=x onerror=alert(1)>',
  '<script>alert(1)</script>',
  '<javascript:alert(1)>',
  '<mailto:a@evil.test>',
  '<https://example.com/known>',
  'a < b and c > d',
  '<!-- hidden -->',
  '<details open ontoggle=alert(1)>',
  '>quote',
  '<<<>>>',
];

/** Renders one act-now item with these overrides; returns its table row. */
function rowOf(patch: Partial<DigestItem>): { markdown: string; cells: string[] } {
  const item = makeDigestItem(makeItem(), { urgency: 'act-now', action: 'Go.', ...patch });
  const markdown = renderDigest({ ...makeDigest([]), items: [item] }, NONE);
  const rows = markdown.split('\n').filter((line) => line.startsWith('| ['));
  expect(rows).toHaveLength(1);
  return { markdown, cells: splitCells(rows[0]!) };
}

describe('angle brackets are escaped in digest.md', () => {
  it.each(TAGS)('in a summary, an action and a title: %s', (text) => {
    const { markdown } = rowOf({ summary: text, action: text, title: text });

    expect(markdown).not.toMatch(LIVE_ANGLE);
  });

  it('in the headline', () => {
    const digest = { ...makeDigest([]), headline: '<svg onload=alert(1)> note', items: [] };
    const markdown = renderDigest(digest, NONE);

    expect(markdown.split('\n')[2]).toBe('_\\<svg onload=alert(1)\\> note_');
  });

  it('as the reviewer found them: the RSS title and the model text', () => {
    const { cells } = rowOf({
      title: '<svg onload=alert(1)> Release 1',
      url: 'https://feed.example/p/1',
      summary: '<img src=https://feed.example/p/1 onerror=alert(1)> <javascript:alert(1)>',
      action: '<mailto:a@evil.test>',
    });

    expect(cells).toEqual([
      ' [\\<svg onload=alert(1)\\> Release 1](https://feed.example/p/1) ',
      ' \\<img src=https://feed.example/p/1 onerror=alert(1)\\> \\<javascript:alert(1)\\> ',
      ' \\<mailto:a@evil.test\\> ',
    ]);
  });

  it('with an odd number of backslashes before it, whatever the writer put there', () => {
    const { markdown } = rowOf({
      summary: '\\<a href=x> \\\\<b> \\\\\\<c> x\\',
      action: '\\>',
      title: 'T \\<b>',
    });

    expect(markdown).not.toMatch(LIVE_ANGLE);
  });

  it('and shows the text the writer wrote, backslashes included', () => {
    const { cells } = rowOf({ summary: 'C:\\<dir> and \\\\<dir>' });

    // `\\\<` is a backslash and a `<`; `\\\\\<` is two backslashes and a `<`.
    expect(cells[1]).toBe(' C:\\\\\\<dir\\> and \\\\\\\\\\<dir\\> ');
  });

  it('leaves the destination, the title of the page and plain text alone', () => {
    const { markdown, cells } = rowOf({
      title: 'Plain title',
      url: 'https://example.com/p?x=1&y=2',
      summary: 'Plain summary, with (parentheses) and an & ampersand.',
    });

    expect(cells[0]).toBe(' [Plain title](https://example.com/p?x=1&y=2) ');
    expect(cells[1]).toBe(' Plain summary, with (parentheses) and an & ampersand. ');
    expect(markdown).not.toContain('\\<');
  });

  it('in a destination too, if a collected url holds one', () => {
    const { markdown } = rowOf({ url: 'https://example.com/p?x=<b>' });

    expect(markdown).not.toMatch(LIVE_ANGLE);
  });

  it('and keeps a row as wide as its header', () => {
    const item = makeDigestItem(makeItem(), { urgency: 'act-now', action: '<a | b>' });
    const markdown = renderDigest({ ...makeDigest([]), items: [item] }, NONE);
    const rows = markdown.split('\n').filter((line) => line.startsWith('|'));

    expect(new Set(rows.map((row) => splitCells(row).length)).size).toBe(1);
  });
});

describe('reading a digest.md with escaped angle brackets back', () => {
  const view = (patch: Partial<DigestView['groups'][number]['items'][number]>): DigestView => ({
    weekId: '2026-W42',
    title: 'Week 2026-W42: 1 release, 1 needs action',
    headline: 'Headline',
    groups: [
      {
        urgency: 'act-now',
        label: 'Act now',
        items: [
          {
            title: 'T',
            url: 'https://example.com/t',
            whatChanged: 'W',
            action: 'A',
            ...patch,
          },
        ],
      },
    ],
  });

  it.each(TAGS)('round-trips %s through a cell, a title and the headline', (text) => {
    const original = { ...view({ title: text, whatChanged: text, action: text }), headline: text };

    const read = readSavedView(renderView(original));

    expect(read).toEqual({
      ...original,
      headline: text.trim(),
      groups: [
        {
          ...original.groups[0]!,
          items: [{ ...original.groups[0]!.items[0]!, title: text.trim() }],
        },
      ],
    });
  });

  it.each([
    ['one backslash', 'a\\<b'],
    ['two backslashes', 'a\\\\<b'],
    ['three backslashes', 'a\\\\\\<b'],
    ['a backslash after it', 'a<\\b'],
    ['a trailing backslash after a bracket', 'a>\\'],
    ['backslashes, pipes and brackets mixed', '\\|<\\\\|>\\<|\\'],
  ])('round-trips %s', (_name, text) => {
    const original = { ...view({ title: text, whatChanged: text, action: text }), headline: text };

    const read = readSavedView(renderView(original));

    expect(read?.headline).toBe(text);
    expect(read?.groups[0]?.items[0]).toEqual({
      title: text,
      url: 'https://example.com/t',
      whatChanged: text,
      action: text,
    });
  });

  it('round-trips a destination with an angle bracket', () => {
    const original = view({ url: 'https://example.com/p?x=<b>\\<c>' });

    expect(readSavedView(renderView(original))).toEqual(original);
    expect(readSavedDigest(renderView(original)).urls).toEqual([
      'https://example.com/p?x=<b>\\<c>',
    ]);
  });

  it('gives the headline and urls of an escaped file to a resume', () => {
    const original = { ...view({ title: '<b>x</b>' }), headline: '<i>head</i>' };

    expect(readSavedDigest(renderView(original))).toEqual({
      headline: '<i>head</i>',
      urls: ['https://example.com/t'],
    });
  });

  it('reads a file written before the escapes (raw brackets) as it always did', () => {
    const old = [
      '# Week 2026-W42: 1 release, 1 needs action',
      '',
      '_Old <b>headline</b>_',
      '',
      '## 🔴 Act now',
      '',
      '| Release | What changed | What to do |',
      '|---|---|---|',
      '| [Old <svg> title](https://example.com/old) | Adds <img src=x> and a > b. | Fix <script>. |',
      '',
    ].join('\n');

    expect(readSavedView(old)?.headline).toBe('Old <b>headline</b>');
    expect(readSavedView(old)?.groups[0]?.items[0]).toEqual({
      title: 'Old <svg> title',
      url: 'https://example.com/old',
      whatChanged: 'Adds <img src=x> and a > b.',
      action: 'Fix <script>.',
    });
    expect(readSavedDigest(old)).toEqual({
      headline: 'Old <b>headline</b>',
      urls: ['https://example.com/old'],
    });
  });

  it('leaves a backslash run with an even length before a bracket as it was written', () => {
    const old = [
      '# Week 2026-W42: 1 release, 1 needs action',
      '',
      '## 🔴 Act now',
      '',
      '| Release | What changed | What to do |',
      '|---|---|---|',
      '| [T](https://example.com/old) | a\\\\<b | c |',
    ].join('\n');

    expect(readSavedView(old)?.groups[0]?.items[0]?.whatChanged).toBe('a\\\\<b');
  });
});

describe('the link check sees the same links through the escapes', () => {
  const known = makeItem({ url: 'https://example.com/known' });
  const withText = (summary: string): { digest: Digest; markdown: string } => {
    const digest = makeDigest([known]);
    const changed = { ...digest, items: [{ ...digest.items[0]!, summary }] };
    return { digest: changed, markdown: renderDigest(changed, NONE) };
  };

  it.each([
    ['an autolink to an uncollected url', '<https://evil.example/x>', false],
    ['a link to an uncollected url', '<a href="https://evil.example/x">x</a>', false],
    ['a Markdown link to an uncollected url', '<b>[x](https://evil.example/x)</b>', false],
    ['an image of an uncollected url', '<img src=https://evil.example/x>', false],
    ['a scheme-less host', '<www.evil.example>', false],
    ['an autolink to a collected url', '<https://example.com/known>', true],
    ['a collected url in angle brackets and prose', 'see <https://example.com/known>.', true],
    ['a tag that holds no link', '<b>bold</b> and <i>italic</i>', true],
  ])('%s gives the same verdict as the unescaped text', (_name, text, ok) => {
    const { digest, markdown } = withText(text);
    const raw = markdown.replace(/\\([<>])/g, '$1');

    expect(markdown).toContain('\\<');
    expect(raw).not.toBe(markdown);
    expect(linkCheck(digest, markdown, [known])).toEqual(linkCheck(digest, raw, [known]));
    expect(linkCheck(digest, markdown, [known]).ok).toBe(ok);
  });

  it('finds the url of an escaped autolink in the Markdown alone', () => {
    const { digest, markdown } = withText('x');
    const hostile = `${markdown}\n| [a](https://example.com/known) | \\<https://evil.example/x\\> | Go. |`;

    expect(linkCheck(digest, hostile, [known]).problems).toEqual([
      'Unknown URL not in collected items: https://evil.example/x',
    ]);
  });

  it('keeps the format check as it was: an escape adds no word', () => {
    const { digest, markdown } = withText('<b>bold</b> change');
    const raw = markdown.replace(/\\([<>])/g, '$1');

    expect(formatCheck(digest, markdown)).toEqual(formatCheck(digest, raw));
  });
});
