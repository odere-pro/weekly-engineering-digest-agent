// Builders shared by the source conformance tests: items that pass every check, a recording
// around them, and fetcher factories that serve canned items instead of parsing a body.
import type { Item, Source } from '../../../src/domain/schemas';
import { itemIdFor } from '../../../src/shared/url';
import { makeItem } from '../../../test/builders';
import { FakeSourceFetcher } from '../../../test/fakes/FakeSourceFetcher';
import type { SourceRecording } from '../recordings/types';
import type { SourceFetcherFactories } from '../replayFetch/fetcherFactories';

/** Longer than `MIN_SUMMARY_CHARS`, so an item with it counts as having a summary. */
export const LONG_SUMMARY = 'A summary that is comfortably longer than forty characters.';

export const feedA: Source = { id: 'feed-a', kind: 'rss', url: 'https://openai.com/news/rss.xml' };
export const repoB: Source = {
  id: 'repo-b',
  kind: 'github',
  url: 'https://github.com/ollama/ollama',
};

/** An item on an allowed host, with the right id, a real title and summary, and a valid date. */
export function goodItem(sourceId: string, n: number, overrides: Partial<Item> = {}): Item {
  const url = `https://openai.com/news/post-${n}`;
  return makeItem({
    id: itemIdFor(url),
    sourceId,
    url,
    title: `Post ${n}`,
    summary: LONG_SUMMARY,
    publishedAt: '2026-10-12T09:00:00.000Z',
    ...overrides,
  });
}

/** A recording of `source` that serves `<rss/>` and must yield `expectedItems`. */
export function recording(
  source: Source,
  expectedItems: Item[],
  overrides: Partial<SourceRecording['expected']> = {},
): SourceRecording {
  return {
    source,
    response: {
      url: source.url,
      status: 200,
      contentType: 'application/xml',
      fetchedAt: '2026-10-17T08:00:00.000Z',
      bodyFile: 'body.xml',
    },
    body: '<rss/>',
    pages: {},
    expected: {
      reviewed: true,
      entryCount: expectedItems.length,
      items: expectedItems,
      knownGaps: [],
      ...overrides,
    },
  };
}

/** Factories whose fetchers return the canned items (or throw the error) of each source id. */
export function factoriesFor(
  byKind: Partial<Record<'rss' | 'github', Record<string, Item[] | Error>>>,
): SourceFetcherFactories {
  return {
    rss: () => new FakeSourceFetcher('rss', byKind.rss ?? {}),
    github: () => new FakeSourceFetcher('github', byKind.github ?? {}),
  };
}
