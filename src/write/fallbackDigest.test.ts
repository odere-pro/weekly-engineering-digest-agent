import { describe, expect, it } from 'vitest';
import { FALLBACK_NOTE } from '../render/layout';
import {
  FALLBACK_WRITER,
  buildFallbackDigest,
  checkedFallback,
  cutSummary,
} from './fallbackDigest';
import { DIGEST_SUMMARY_WORD_LIMIT } from '../checks/formatCheck';
import { makeScoredItem } from '../../test/builders';

const WEEK = '2026-W42';
const words = (text: string): number => text.split(/\s+/).filter(Boolean).length;
const items = (summary = 'It ships faster builds. It also fixes a bug.') =>
  Array.from({ length: 4 }, (_, i) => makeScoredItem({ title: `Runner ${i}`, summary }));
const options = (selected = items()) => ({
  weekId: WEEK,
  topN: 5,
  collected: selected,
  disabledGuards: [],
});

describe('cutSummary', () => {
  it('keeps whole sentences that fit under the word limit', () => {
    const text = 'one two three four five. six seven eight nine ten.';

    expect(cutSummary(text, 6)).toBe('one two three four five.');
    expect(cutSummary(text, 10)).toBe(text);
  });

  it('cuts a first sentence that is too long at a word, with an ellipsis', () => {
    const cut = cutSummary('word '.repeat(100).trim() + '.', 10);

    expect(words(cut)).toBe(10);
    expect(cut.endsWith('...')).toBe(true);
  });

  it('drops links, em dashes, pipes and character references from the text', () => {
    const cut = cutSummary('See https://evil.example/x now — a|b www.evil.test &#99; done.', 40);

    expect(cut).toBe('See now - a b done.');
  });

  it('gives a fixed line for an empty summary', () => {
    expect(cutSummary('   ', 40)).toBe('No summary in the source.');
  });
});

describe('buildFallbackDigest', () => {
  it('has one entry per selected item with its own title and url', () => {
    const selected = items();

    const digest = buildFallbackDigest(selected, options(selected));

    expect(digest.items.map((i) => [i.itemId, i.title, i.url])).toEqual(
      selected.map((i) => [i.id, i.title, i.url]),
    );
    expect(digest.weekId).toBe(WEEK);
  });

  it('names the distinct areas in the headline', () => {
    const selected = [
      makeScoredItem({}, { area: 'Platform engineering' }),
      makeScoredItem({}, { area: 'AI models and tooling' }),
      makeScoredItem({}, { area: 'Platform engineering' }),
    ];

    const { headline } = buildFallbackDigest(selected, options(selected));

    expect(headline).toBe('Releases this week: Platform engineering, AI models and tooling');
  });

  it('keeps at most topN items', () => {
    const selected = Array.from({ length: 5 }, () => makeScoredItem());

    expect(buildFallbackDigest(selected, { ...options(selected), topN: 3 }).items).toHaveLength(3);
  });

  it('uses the url as the title when the title is blank', () => {
    const selected = [makeScoredItem({ title: ' ' }), makeScoredItem(), makeScoredItem()];

    const [first] = buildFallbackDigest(selected, options(selected)).items;

    expect(first?.title).toBe(selected[0]?.url);
  });
});

describe('checkedFallback', () => {
  it('passes the link and format checks and names itself in the footer', () => {
    const selected = items();

    const checked = checkedFallback(selected, options(selected));

    expect(checked.rejectedBy).toEqual([]);
    expect(checked.markdown).toContain(FALLBACK_NOTE);
    expect(checked.draft.writer).toBe(FALLBACK_WRITER);
  });

  it('passes the checks on hostile text: links, em dashes, long summaries, long titles', () => {
    const hostile = [
      'Go to https://evil.example/a — or [x](https://evil.example/b) | www.evil.test ' +
        `${'filler '.repeat(80)}end.`,
      'ftp://evil.example/p and //evil.example/q and javascript:alert(1)',
      '',
      'see href=/docs/x now, foo src=bar, a&colon; b http&colon; c, back\\slash',
    ];
    const selected = hostile.map((summary) =>
      makeScoredItem({ summary, title: `T — ${'long '.repeat(80)} https://evil.example/t` }),
    );

    const checked = checkedFallback(selected, options(selected));

    expect(checked.problems).toEqual([]);
    expect(checked.markdown).not.toContain('evil');
  });

  it('keeps every summary within the format limit', () => {
    const selected = items('word '.repeat(300));

    const { digest } = checkedFallback(selected, options(selected)).draft;

    for (const item of digest.items) {
      expect(words(item.summary)).toBeLessThanOrEqual(DIGEST_SUMMARY_WORD_LIMIT);
    }
  });
});
