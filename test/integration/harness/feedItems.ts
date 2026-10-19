import { type Item } from '../../../src/domain/schemas';
import { DATA_OPEN } from '../../../src/shared/untrusted';
import { makeItem } from '../../builders';

const HOUR_MS = 3_600_000;

export interface FeedItems {
  rss: Item[];
  github: Item[];
}

/**
 * Four items inside the window (one is a patch release, dropped as minor) and one too old.
 * URLs are fixed, as a real feed's are, so every world (process) sees the same items.
 */
export function feedItems(now: Date): FeedItems {
  const ago = (hours: number): string => new Date(now.getTime() - hours * HOUR_MS).toISOString();
  return {
    rss: [
      makeItem({
        sourceId: 'model-blog',
        url: 'https://example.com/posts/gemma-4',
        title: 'Gemma 4 adds tool calling',
        publishedAt: ago(72),
      }),
      makeItem({
        sourceId: 'model-blog',
        url: 'https://example.com/posts/model-router-2',
        title: 'Model router 2.0',
        publishedAt: ago(48),
      }),
      makeItem({
        sourceId: 'model-blog',
        url: 'https://example.com/posts/old-news',
        title: 'Old news',
        publishedAt: ago(24 * 40),
      }),
    ],
    github: [
      makeItem({
        sourceId: 'runner',
        kind: 'github',
        url: 'https://github.com/example/runner/releases/tag/v3.0.0',
        title: 'runner v3.0.0',
        publishedAt: ago(24),
      }),
      makeItem({
        sourceId: 'runner',
        kind: 'github',
        url: 'https://github.com/example/runner/releases/tag/v2.9.1',
        title: 'runner v2.9.1',
        publishedAt: ago(96),
      }),
    ],
  };
}

/** The items whose untrusted-data block appears in `text`, in the order of `items`. */
export function itemsIn(items: readonly Item[], text: string): Item[] {
  return items.filter((item) => text.includes(`${DATA_OPEN} ${item.id}>>>`));
}
