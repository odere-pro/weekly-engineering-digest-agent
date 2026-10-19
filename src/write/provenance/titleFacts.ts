import type { ScoredItem } from '../../classify/classification';
import type { DigestItem } from '../../domain/schemas';
import type { Logger } from '../../shared/telemetry';
import { printableLine, truncate } from '../../shared/text';
import { SOURCE_TITLE_MAX_CHARS, safeSourceText } from '../tidy/sourceText';
import { missingFacts } from './factTokens';
import { loggedId } from './loggedId';

/** A log line is not the place for a hostile title's whole list of facts. */
const LOGGED_FACTS_MAX = 5;
/** A fact in a log line is model output; keep it short. */
const LOGGED_FACT_MAX_CHARS = 40;

/**
 * The source title as the link text a reader gets: one printable line, without a token that could
 * become a link or a character reference (`safeSourceText`, as the fallback digest does), cut to
 * `SOURCE_TITLE_MAX_CHARS`. Empty when nothing usable is left.
 */
function sourceTitleOf(source: ScoredItem): string {
  return truncate(safeSourceText(printableLine(source.title)), SOURCE_TITLE_MAX_CHARS);
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
  const missing = missingFacts(item.title, source);
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
