// Builders shared by the recorder tests: two sources, and items published at a given time.
import { join } from 'node:path';
import type { Item, Source } from '../../../src/domain/schemas';
import { makeItem } from '../../../test/builders';

/** Config files the recorder tests read: `valid.config.json` has one source, `example-feed`. */
export const CONFIG_FIXTURES = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'test',
  'fixtures',
  'config',
);

export const feedA: Source = { id: 'feed-a', kind: 'rss', url: 'https://a.example.com/feed.xml' };
export const repoB: Source = {
  id: 'repo-b',
  kind: 'github',
  url: 'https://github.com/example/repo-b',
  maxItems: 5,
};

/** An item of `feed-a` published at `publishedAt` (an ISO timestamp). */
export function itemAt(publishedAt: string, overrides: Partial<Item> = {}): Item {
  return makeItem({ sourceId: feedA.id, publishedAt, ...overrides });
}

/** `count` distinct items spread over the day starting at `isoDay` (YYYY-MM-DD). */
export function itemsOnDay(isoDay: string, count: number, overrides: Partial<Item> = {}): Item[] {
  return Array.from({ length: count }, (_, i) =>
    itemAt(`${isoDay}T${String(i % 24).padStart(2, '0')}:30:00Z`, overrides),
  );
}
