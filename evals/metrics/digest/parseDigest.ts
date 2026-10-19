import { readSavedView } from '../../../src/render/markdown';
import type { Digest, DigestItem, Item, Urgency } from '../../../src/domain/schemas';
import type { DigestViewItem } from '../../../src/render/digestView';
import { normalizeUrl } from '../../../src/shared/url';

/** The layout does not print the area, so a parsed item cannot know it. */
const UNKNOWN_AREA = 'unknown';

function parsedItem(
  item: DigestViewItem,
  urgency: Urgency,
  idByUrl: ReadonlyMap<string, string>,
): DigestItem {
  return {
    itemId: idByUrl.get(normalizeUrl(item.url)) ?? `unmatched:${item.url}`,
    title: item.title,
    url: item.url,
    area: UNKNOWN_AREA,
    summary: item.whatChanged,
    // The layout prints the action in the place of why it matters, and no such line at all
    // for a good-to-know item.
    whyItMatters: '',
    urgency,
    ...(item.action === undefined ? {} : { action: item.action }),
  };
}

/**
 * Markdown from `renderDigest` back to a Digest, so the real link and format checks can judge
 * what was written to disk (title, headline in italics, one table per urgency).
 * Item ids are looked up by URL in the collected `items`; a link to anything else gets the id
 * `unmatched:<url>`. The layout prints no intro, so the intro comes back empty, and items come
 * back grouped by urgency, as printed. Missing parts come back empty, never throw.
 */
export function parseDigestMarkdown(
  markdown: string,
  weekId: string,
  items: readonly Item[],
): Digest {
  const idByUrl = new Map(items.map((item) => [normalizeUrl(item.url), item.id]));
  const view = readSavedView(markdown);
  return {
    weekId,
    headline: view?.headline ?? '',
    intro: '',
    items: (view?.groups ?? []).flatMap((group) =>
      group.items.map((item) => parsedItem(item, group.urgency, idByUrl)),
    ),
  };
}

/** Ids of the collected items the digest links to, in digest order. */
export function digestItemIds(markdown: string, items: readonly Item[]): string[] {
  return parseDigestMarkdown(markdown, '', items).items.map((item) => item.itemId);
}
