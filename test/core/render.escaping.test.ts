// Model text in a table cell must never move a column, break a link or start a new row (W8-02).
import { describe, expect, it } from 'vitest';
import { linkCheck } from '../../src/core/checks/linkCheck.js';
import { renderDigest } from '../../src/core/render.js';
import type { DigestItem } from '../../src/core/schemas.js';
import { makeDigest, makeDigestItem, makeItem } from '../builders.js';
import { splitCells } from '../fixtures/render/cells.js';

const NONE = { disabledGuards: [] } as const;

/** Renders one act-now item with these overrides; returns its table row. */
function rowOf(patch: Partial<DigestItem>): string[] {
  const item = makeDigestItem(makeItem(), { urgency: 'act-now', action: 'Go.', ...patch });
  const markdown = renderDigest({ ...makeDigest([]), items: [item] }, NONE);
  const rows = markdown.split('\n').filter((line) => line.startsWith('| ['));
  expect(rows).toHaveLength(1);
  return splitCells(rows[0]!);
}

describe('a pipe in a cell', () => {
  it('is escaped so it does not split the row', () => {
    const cells = rowOf({ summary: 'a | b', action: '| c |' });

    expect(cells).toEqual([expect.any(String), ' a \\| b ', ' \\| c \\| ']);
  });

  it.each([
    ['one backslash', 'use a\\|b here', ' use a\\\\\\|b here '],
    ['two backslashes', 'use a\\\\|b here', ' use a\\\\\\\\\\|b here '],
    ['a backslash apart from the pipe', 'C:\\temp | x', ' C:\\temp \\| x '],
  ])('keeps its own escape when %s comes right before it', (_name, summary, shown) => {
    expect(rowOf({ summary })).toEqual([expect.any(String), shown, ' Go. ']);
  });

  it('leaves a lone trailing backslash where it is', () => {
    expect(rowOf({ action: 'Go\\' })).toEqual([expect.any(String), expect.any(String), ' Go\\ ']);
  });
});

describe('a line break in a cell', () => {
  it.each([
    ['LF', 'one\ntwo'],
    ['CRLF', 'one\r\ntwo'],
    ['CR', 'one\rtwo'],
    ['a blank line', 'one\n\ntwo'],
    ['tabs and runs of spaces', 'one \t  two'],
  ])('turns %s into one space', (_name, summary) => {
    expect(rowOf({ summary })[1]).toBe(' one two ');
  });
});

describe('the release cell', () => {
  it('escapes brackets and backslashes in the title so the link stays whole', () => {
    const [release] = rowOf({ title: 'Parser [beta] v1\\', url: 'https://example.com/p' });

    expect(release).toBe(' [Parser \\[beta\\] v1\\\\](https://example.com/p) ');
  });

  it('escapes a pipe in the title, with or without a backslash before it', () => {
    expect(rowOf({ title: 'a | b', url: 'https://example.com/p' })[0]).toBe(
      ' [a \\| b](https://example.com/p) ',
    );
    expect(rowOf({ title: 'a \\| b', url: 'https://example.com/p' })[0]).toBe(
      ' [a \\\\\\| b](https://example.com/p) ',
    );
  });

  it('escapes a pipe and a backslash in the url', () => {
    expect(rowOf({ url: 'https://example.com/p?x=a|b' })[0]).toContain(
      '](https://example.com/p?x=a\\|b) ',
    );
    expect(rowOf({ url: 'https://example.com/p?x=a\\b' })[0]).toContain(
      '](https://example.com/p?x=a\\\\b) ',
    );
  });

  it('keeps a title that looks like the end of a link from ending it', () => {
    const [release] = rowOf({ title: 'x](https://evil.example/)', url: 'https://example.com/p' });

    expect(release).toBe(' [x\\](https://evil.example/)](https://example.com/p) ');
  });

  it('shows the url when the title is blank', () => {
    expect(rowOf({ title: ' \n ', url: 'https://example.com/p' })[0]).toBe(
      ' [https://example.com/p](https://example.com/p) ',
    );
  });

  it('puts a title with a line break on one line', () => {
    expect(rowOf({ title: 'a\nb', url: 'https://example.com/p' })[0]).toBe(
      ' [a b](https://example.com/p) ',
    );
  });
});

describe('the headline', () => {
  it('collapses onto one line', () => {
    const item = makeDigestItem(makeItem(), { urgency: 'act-now', action: 'Go.' });
    const digest = { ...makeDigest([]), headline: 'a\n  b ', items: [item] };

    expect(renderDigest(digest, NONE).split('\n')[2]).toBe('_a b_');
  });
});

describe('the link check on escaped urls', () => {
  it.each([
    'https://example.com/q?x=a|b',
    'https://example.com/q?x=a\\b',
    'https://example.com/q?x=a\\|b',
    'https://example.com/wiki/Foo_(bar)',
  ])('accepts the rendered digest when %s was collected', (url) => {
    const item = makeDigestItem(makeItem({ url }), {
      url,
      title: 'Tool | [x] \\',
      urgency: 'act-now',
      action: 'Go.',
    });
    const digest = { ...makeDigest([]), items: [item] };
    const markdown = renderDigest(digest, NONE);

    expect(linkCheck(digest, markdown, [makeItem({ url })])).toEqual({ ok: true, problems: [] });
  });

  it('still rejects a link smuggled into the title', () => {
    const item = makeDigestItem(makeItem(), {
      title: 'x](https://evil.example/)',
      urgency: 'act-now',
      action: 'Go.',
    });
    const digest = { ...makeDigest([]), items: [item] };
    const markdown = renderDigest(digest, NONE);

    const result = linkCheck(digest, markdown, [makeItem({ url: item.url })]);

    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toContain('https://evil.example/');
  });
});
