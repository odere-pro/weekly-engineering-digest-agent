import type { DigestItem, Draft } from '../../domain/schemas';
import { truncate } from '../../shared/text';
import { withoutEmDashes } from '../tidy/emDashes';
import { indexCollectedUrls, withSchemes } from './withSchemes';

/** What `DigestItemSchema` allows for an action. */
const ACTION_MAX_CHARS = 200;

export interface PreparedDraft {
  readonly draft: Draft;
  /** How many links got their `https://`. */
  readonly repairedLinks: number;
}

/**
 * Deterministic fixes the writers keep needing: at most topN items (defense in depth), no em
 * dashes, and `https://` on a link that names a collected item without it (W5-11).
 */
export function prepareDraft(draft: Draft, topN: number, collectedUrls: readonly string[]): Draft {
  return prepareWithCount(draft, topN, collectedUrls).draft;
}

/** `prepareDraft`, and how many links it fixed, for the log line. */
export function prepareWithCount(
  draft: Draft,
  topN: number,
  collectedUrls: readonly string[],
): PreparedDraft {
  const { digest } = draft;
  const known = indexCollectedUrls(collectedUrls);
  let repairedLinks = 0;
  const tidy = (text: string): string =>
    withSchemes(withoutEmDashes(text), known, () => {
      repairedLinks += 1;
    });
  const items = digest.items.slice(0, topN).map((item): DigestItem => ({
    ...item,
    title: tidy(item.title),
    area: tidy(item.area),
    summary: tidy(item.summary),
    whyItMatters: tidy(item.whyItMatters),
    // No link repair: an action may not hold a link at all, and the format check says so.
    ...(item.action === undefined
      ? {}
      : { action: truncate(withoutEmDashes(item.action), ACTION_MAX_CHARS) }),
  }));
  const headline = tidy(digest.headline);
  const prepared = { ...draft, digest: { ...digest, headline, intro: tidy(digest.intro), items } };
  return { draft: prepared, repairedLinks };
}
