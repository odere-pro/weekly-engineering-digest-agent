import type { ScoredItem } from '../../classify/classification';
import type { DigestItem } from '../../domain/schemas';
import type { Logger } from '../../shared/telemetry';
import { printableLine, truncate } from '../../shared/text';
import { factTokensOf, missingFacts } from './factTokens';
import { loggedId } from './loggedId';

/** A log line is not the place for a hostile title's whole list of facts. */
const LOGGED_FACTS_MAX = 5;
/** A fact in a log line is model output; keep it short. */
const LOGGED_FACT_MAX_CHARS = 40;
/** The repaired title is link text; the fallback digest cuts a title at the same length. */
const TITLE_MAX_CHARS = 120;
/** A version with no pre-release: digits and dots only, like `1.31`. */
const PLAIN_VERSION = /^\d+(?:\.\d+)+$/;
/**
 * A token of a source title that could become a link or a character reference. The link check
 * would reject the draft for it, so the repair leaves the token out (as the fallback digest does).
 */
const LINK_LIKE = /:\/\/|\b(?:https?|ftp|mailto|javascript):|\bwww\.|\/\/|\]\(|&#/i;
const CHARACTER_REFERENCE = /&[#a-z0-9]+;/i;

/**
 * The shorter forms of the plain versions in `facts`: `1.31` for `1.31.2`, `1.31` and `1.31.2`
 * for `1.31.2.1`. A version with a pre-release gives none: "1.17" for `1.17.0-beta1` would
 * announce a beta as the release.
 */
function shorterVersions(facts: readonly string[]): Set<string> {
  const shorter = new Set<string>();
  for (const fact of facts) {
    if (!PLAIN_VERSION.test(fact)) continue;
    const numbers = fact.split('.');
    for (let length = 2; length < numbers.length; length += 1) {
      shorter.add(numbers.slice(0, length).join('.'));
    }
  }
  return shorter;
}

/**
 * The versions, advisory ids and dates in a written title that the source title and summary do
 * not have (`missingFacts`). A title may name a shorter version than the source ("Kubernetes
 * 1.31" for "v1.31.2" is not wrong), so a plain version that is a shorter form of a plain source
 * version is not missing. A pre-release must match exactly.
 */
export function missingTitleFacts(title: string, source: ScoredItem): string[] {
  const missing = missingFacts(title, source);
  if (missing.length === 0) return missing;
  const shorter = shorterVersions([...factTokensOf(source.title), ...factTokensOf(source.summary)]);
  return missing.filter((token) => !shorter.has(token));
}

/**
 * The source title as the link text a reader gets: one printable line, without a token that
 * could become a link, cut to `TITLE_MAX_CHARS`. Empty when nothing usable is left.
 */
function sourceTitleOf(source: ScoredItem): string {
  const safe = printableLine(source.title)
    .split(/\s+/)
    .filter((token) => token !== '' && !LINK_LIKE.test(token) && !CHARACTER_REFERENCE.test(token))
    .join(' ');
  return truncate(safe, TITLE_MAX_CHARS);
}

/**
 * Grounds the title in its source, the way `withSourceUrl` grounds the url (W12-02). A title that
 * names a version, advisory id or date its source does not have is replaced by the source title,
 * so a wrong version never ships as link text, and no draft is rejected for it. Any other title
 * is returned as is. A source with no usable title cannot repair anything: the item stays, and
 * the log says so. The source title is used as collected: no recorded week has a bare tag for a
 * title, because the GitHub adapters already build `<repo> <tag>`.
 */
export function groundTitle(item: DigestItem, source: ScoredItem, logger: Logger): DigestItem {
  const missing = missingTitleFacts(item.title, source);
  if (missing.length === 0) return item;
  const fields = {
    itemId: loggedId(item.itemId),
    missing: missing
      .slice(0, LOGGED_FACTS_MAX)
      .map((fact) => truncate(fact, LOGGED_FACT_MAX_CHARS)),
    missingCount: missing.length,
  };
  const title = sourceTitleOf(source);
  if (title === '') {
    logger.warn(
      'Digest title names a fact its source lacks, and the source has no title to use',
      fields,
    );
    return item;
  }
  logger.warn('Replaced a digest title that names a fact its source lacks', fields);
  return { ...item, title };
}

/**
 * `groundTitle` for each item of a draft, with the source its `itemId` names. An item with no
 * source is returned as is; `enforceProvenance` has already dropped those.
 */
export function groundTitles(
  items: readonly DigestItem[],
  sources: ReadonlyMap<string, ScoredItem>,
  logger: Logger,
): DigestItem[] {
  return items.map((item) => {
    const source = sources.get(item.itemId);
    return source === undefined ? item : groundTitle(item, source, logger);
  });
}
