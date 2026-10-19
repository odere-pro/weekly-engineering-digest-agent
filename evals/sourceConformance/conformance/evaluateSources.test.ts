import { describe, expect, it } from 'vitest';
import type { Item } from '../../../src/domain/schemas';
import { itemIdFor } from '../../../src/shared/url';
import { factoriesFor, feedA, goodItem, recording, repoB } from '../__fixtures__/conformanceKit';
import { evaluateSources } from './evaluateSources';
import { MIN_SUMMARY_CHARS } from './tally';

describe('evaluateSources', () => {
  it('counts a clean source as fully parsed with no defects', async () => {
    const items = [goodItem('feed-a', 1), goodItem('feed-a', 2)];
    const [result] = await evaluateSources(
      [recording(feedA, items)],
      factoriesFor({ rss: { 'feed-a': items } }),
    );

    expect(result).toEqual({
      sourceId: 'feed-a',
      parsed: 2,
      expected: 2,
      schemaInvalid: 0,
      emptyTitle: 0,
      emptySummary: 0,
      badDate: 0,
      idMismatch: 0,
      hostOutsideAllowlist: 0,
    });
  });

  it('counts every kind of defect on the items a fetcher returns', async () => {
    const expected = [1, 2, 3, 4, 5, 6].map((n) => goodItem('repo-b', n));
    const returned: Item[] = [
      goodItem('repo-b', 1, { title: '  ' }),
      goodItem('repo-b', 2, { summary: 'x'.repeat(MIN_SUMMARY_CHARS - 1) }),
      goodItem('repo-b', 3, { publishedAt: 'last Tuesday' }),
      goodItem('repo-b', 4, { id: 'not-the-hash' }),
      goodItem('repo-b', 5, {
        url: 'https://evil.example.net/x',
        id: itemIdFor('https://evil.example.net/x'),
      }),
      goodItem('repo-b', 6, { url: 'not a url' }),
    ];
    const [result] = await evaluateSources(
      [recording(repoB, expected)],
      factoriesFor({ github: { 'repo-b': returned } }),
    );

    expect(result).toMatchObject({
      sourceId: 'repo-b',
      parsed: 6,
      expected: 6,
      emptyTitle: 1,
      emptySummary: 1,
      badDate: 1,
      idMismatch: 2, // item 4, and item 6 whose url is not a url
      hostOutsideAllowlist: 2, // item 5, and item 6 whose host cannot be read
    });
    expect(result?.schemaInvalid).toBe(2); // the bad date and the bad url
  });

  it('records a fetcher that throws as zero parsed items with the reason', async () => {
    const [result] = await evaluateSources(
      [recording(feedA, [goodItem('feed-a', 1)])],
      factoriesFor({ rss: { 'feed-a': new Error('Cannot parse feed feed-a') } }),
    );

    expect(result).toMatchObject({ parsed: 0, expected: 1, error: 'Cannot parse feed feed-a' });
  });

  it('runs the fetcher of the source kind over each recording', async () => {
    const results = await evaluateSources(
      [
        recording(feedA, [goodItem('feed-a', 1)]),
        recording(repoB, [goodItem('repo-b', 2), goodItem('repo-b', 3)]),
      ],
      factoriesFor({
        rss: { 'feed-a': [goodItem('feed-a', 1)] },
        github: { 'repo-b': [goodItem('repo-b', 2)] },
      }),
    );

    expect(results.map((r) => [r.sourceId, r.parsed, r.expected])).toEqual([
      ['feed-a', 1, 1],
      ['repo-b', 1, 2],
    ]);
  });

  it('keeps going after a source fails and has no error on the others', async () => {
    const results = await evaluateSources(
      [recording(feedA, [goodItem('feed-a', 1)]), recording(repoB, [goodItem('repo-b', 2)])],
      factoriesFor({
        rss: { 'feed-a': new Error('boom') },
        github: { 'repo-b': [goodItem('repo-b', 2)] },
      }),
    );

    expect(results.map((r) => r.error)).toEqual(['boom', undefined]);
  });

  it('is empty without recordings', async () => {
    expect(await evaluateSources([], factoriesFor({}))).toEqual([]);
  });
});
