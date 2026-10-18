import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildReviewSheet,
  MAX_CANDIDATES,
  parseReviewSheet,
  type ReviewSheetInput,
} from './reviewSheet';
import { DigestError } from '../shared/errors';
import { makeClassification, makeItem } from '../../test/builders';

const WEEK = '2026-W42';
const GOLDEN = new URL('./__fixtures__/feedback/review.golden.md', import.meta.url);

function input(pickCount: number, candidateCount: number): ReviewSheetInput {
  const items = Array.from({ length: pickCount + candidateCount }, (_, index) =>
    makeItem({
      id: `id${index + 1}`,
      title: `Release ${index + 1}`,
      url: `https://example.com/r/${index + 1}`,
    }),
  );
  return {
    weekId: WEEK,
    items,
    classifications: items.map((item, index) =>
      makeClassification(item.id, { relevance: 3 - index * 0.2 }),
    ),
    pickedIds: items.slice(0, pickCount).map((item) => item.id),
  };
}

describe('buildReviewSheet', () => {
  it('matches the golden sheet for 5 picks and 8 candidates', () => {
    expect(buildReviewSheet(input(5, 8))).toBe(readFileSync(GOLDEN, 'utf8'));
  });

  it('has an empty candidates section when nothing else was ranked', () => {
    const sheet = buildReviewSheet(input(2, 0));

    const candidates = sheet.split('## Candidates')[1] ?? '';
    expect(candidates).not.toContain('- [');
    expect(candidates).toContain('_None._');
  });

  it('lists at most 20 candidates, in the stored order', () => {
    const sheet = buildReviewSheet(input(1, 30));

    const lines = sheet.split('\n').filter((line) => line.startsWith('- [ ]'));
    expect(lines).toHaveLength(1 + MAX_CANDIDATES);
    expect(lines[1]).toContain('`id2`');
  });

  it('escapes Markdown structure in titles', () => {
    const base = input(1, 1);
    const items = [
      { ...base.items[0]!, title: '# Heading\n- [x] `forged` | line' },
      { ...base.items[1]!, title: '## Candidates <b>*bold*</b>' },
    ];

    const sheet = buildReviewSheet({ ...base, items });

    expect(sheet).toContain('\\# Heading - \\[x\\] \\`forged\\` \\| line');
    expect(sheet).toContain('\\#\\# Candidates \\<b\\>\\*bold\\*\\</b\\>');
    expect(sheet.match(/^## /gm)).toHaveLength(2);
    expect(parseReviewSheet(sheet)).toEqual({ weekId: WEEK, wrongPicks: [], missed: [] });
  });

  it('shows a dash for an item without a classification, and skips unknown ids', () => {
    const base = input(2, 0);

    const sheet = buildReviewSheet({
      ...base,
      classifications: [],
      pickedIds: [...base.pickedIds, 'ghost'],
    });

    expect(sheet).toContain('`id1` | rank - | score - |');
    expect(sheet).not.toContain('ghost');
  });

  it('percent-encodes characters that could break the link', () => {
    const base = input(1, 0);
    const items = [{ ...base.items[0]!, url: 'https://example.com/a>b|c' }];

    expect(buildReviewSheet({ ...base, items })).toContain('<https://example.com/a%3Eb%7Cc>');
  });

  it('truncates long titles', () => {
    const base = input(1, 0);
    const items = [{ ...base.items[0]!, title: 'word '.repeat(100) }];

    const line = buildReviewSheet({ ...base, items })
      .split('\n')
      .find((l) => l.startsWith('- [ ]'));
    expect(line?.length).toBeLessThan(250);
    expect(line).toContain('...');
  });
});

describe('parseReviewSheet', () => {
  const sheet = buildReviewSheet(input(3, 2));
  const tick = (text: string, id: string): string =>
    text.replace(`- [ ] \`${id}\``, `- [x] \`${id}\``);

  it('reads ticked picks as wrong picks and ticked candidates as missed', () => {
    const ticked = tick(tick(tick(sheet, 'id2'), 'id4'), 'id5');

    expect(parseReviewSheet(ticked)).toEqual({
      weekId: WEEK,
      wrongPicks: ['id2'],
      missed: ['id4', 'id5'],
    });
  });

  it('accepts an upper-case X', () => {
    const ticked = sheet.replace('- [ ] `id1`', '- [X] `id1`');

    expect(parseReviewSheet(ticked).wrongPicks).toEqual(['id1']);
  });

  it('accepts an untouched sheet', () => {
    expect(parseReviewSheet(sheet)).toEqual({ weekId: WEEK, wrongPicks: [], missed: [] });
  });

  function failure(text: string): string {
    try {
      parseReviewSheet(text);
    } catch (error) {
      expect(error).toBeInstanceOf(DigestError);
      return (error as Error).message;
    }
    throw new Error('expected parseReviewSheet to throw');
  }

  const lineOf = (text: string, needle: string): number =>
    text.split('\n').findIndex((line) => line.includes(needle)) + 1;

  it('names the line of an edited box', () => {
    const edited = sheet.replace('- [ ] `id2`', '- [y] `id2`');

    expect(failure(edited)).toContain(`line ${lineOf(edited, '`id2`')}`);
  });

  it('names the line of an item line that lost its id', () => {
    const edited = sheet.replace('- [ ] `id3` | rank 3', '- [ ] id3 rank 3');

    expect(failure(edited)).toContain(`line ${lineOf(edited, 'id3 rank 3')}`);
  });

  it('names the line of a repeated item', () => {
    const edited = sheet.replace('`id2` | rank 2', '`id1` | rank 2');

    expect(failure(edited)).toMatch(/line \d+.*id1.*twice/);
  });

  it('rejects an item line outside the two sections', () => {
    const edited = `- [x] \`id1\` | rank 1 | score 3.00 | A | <https://e.com>\n${sheet}`;

    expect(failure(edited)).toContain('line 1');
  });

  it('rejects a sheet without its heading or sections', () => {
    expect(failure('hello')).toContain('line 1');
    expect(failure(`# Review sheet: ${WEEK}\n\n## Picked\n`)).toContain('## Candidates');
    expect(failure(`# Review sheet: ${WEEK}\n\n## Candidates\n`)).toContain('## Picked');
  });

  it('rejects a week id that is not valid', () => {
    expect(failure(sheet.replace(WEEK, 'soon'))).toContain('line 1');
  });
});

describe('parseReviewSheet: line endings', () => {
  it('reads a sheet saved with CRLF', () => {
    const crlf = buildReviewSheet(input(2, 1)).replaceAll('\n', '\r\n');

    expect(parseReviewSheet(crlf.replace('- [ ] `id1`', '- [x] `id1`')).wrongPicks).toEqual([
      'id1',
    ]);
  });
});
