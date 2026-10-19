import { describe, expect, it } from 'vitest';
import { goodItem } from '../__fixtures__/conformanceKit';
import { conformanceProblems } from './conformanceProblems';

describe('conformanceProblems', () => {
  const expected = [goodItem('feed-a', 1), goodItem('feed-a', 2)];

  it('is empty when the items match', () => {
    expect(conformanceProblems(expected, expected, [])).toEqual([]);
  });

  it('names a missing, an extra and a changed item', () => {
    const actual = [goodItem('feed-a', 1, { title: 'Changed' }), goodItem('feed-a', 3)];
    const problems = conformanceProblems(actual, expected, []);

    expect(problems.join('\n')).toMatch(/missing .*post-2/);
    expect(problems.join('\n')).toMatch(/unexpected .*post-3/);
    expect(problems.join('\n')).toMatch(/title/);
  });

  it('compares dates and urls too', () => {
    const actual = [
      goodItem('feed-a', 1, { publishedAt: '2026-10-13T09:00:00.000Z' }),
      goodItem('feed-a', 2),
    ];
    expect(conformanceProblems(actual, expected, []).join('\n')).toMatch(/publishedAt/);
  });

  it('compares summaries unless the source has a known summary gap', () => {
    const actual = expected.map((item) => ({ ...item, summary: '' }));

    expect(conformanceProblems(actual, expected, []).join('\n')).toMatch(/summary/);
    expect(conformanceProblems(actual, expected, ['summary'])).toEqual([]);
  });

  it('lists missing items first, then unexpected ones, then changed fields', () => {
    const actual = [goodItem('feed-a', 1, { title: 'Changed' }), goodItem('feed-a', 3)];

    expect(conformanceProblems(actual, expected, [])).toEqual([
      'missing https://openai.com/news/post-2',
      'unexpected https://openai.com/news/post-3',
      'https://openai.com/news/post-1: title is "Changed", expected "Post 1"',
    ]);
  });

  it('names the expected value of every field that differs, one problem per field', () => {
    const [first] = expected;
    const actual = [
      { ...first!, sourceId: 'other', kind: 'github' as const, summary: 'short' },
      expected[1]!,
    ];

    expect(conformanceProblems(actual, expected, [])).toEqual([
      'https://openai.com/news/post-1: sourceId is "other", expected "feed-a"',
      'https://openai.com/news/post-1: kind is "github", expected "rss"',
      expect.stringContaining('summary is "short"'),
    ]);
  });

  it('still compares the other fields when the summary gap is known', () => {
    const actual = expected.map((item) => ({ ...item, summary: '', title: 'x' }));

    const problems = conformanceProblems(actual, expected, ['summary']);

    expect(problems).toHaveLength(2);
    expect(problems.join('\n')).not.toMatch(/summary/);
  });

  it('matches items by id, so a reordered list has no problems', () => {
    expect(conformanceProblems([...expected].reverse(), expected, [])).toEqual([]);
  });
});
