import { ItemSchema, type Source } from '../../../domain/schemas';
import { errorMessage } from '../../../shared/errors';
import type { Logger } from '../../../shared/telemetry';
import { truncate } from '../../../shared/text';
import { normalizeEntry } from './normalizeEntry';
import type { Pair, RawEntry } from './types';

/** A feed-controlled error text reaches the log only up to this length. */
const MAX_LOGGED_ERROR_CHARS = 300;

/** What reading a feed's entries gave: the usable pairs, and the messages of entries that threw. */
export interface Reading {
  pairs: Pair[];
  failures: string[];
}

/**
 * Turns the entries an adapter handed over into items. An entry without a usable link or date,
 * or whose item fails `ItemSchema`, is left out quietly; one that throws is left out and counted.
 */
export function readEntries(
  entries: readonly RawEntry[],
  source: Source,
  maxChars: number,
): Reading {
  const pairs: Pair[] = [];
  const failures: string[] = [];
  for (const entry of entries) {
    try {
      const item = normalizeEntry(entry, source, { maxSummaryChars: maxChars });
      if (item && ItemSchema.safeParse(item).success) pairs.push({ entry, item });
    } catch (error) {
      failures.push(errorMessage(error));
    }
  }
  return { pairs, failures };
}

/**
 * One line per feed, not per entry: entries that threw, or a feed whose entries all lack a
 * usable link or date (a changed date format would otherwise empty the feed without a trace).
 */
export function reportUnusable(
  logger: Logger,
  source: Source,
  entryCount: number,
  { pairs, failures }: Reading,
): void {
  if (failures.length > 0) {
    logger.warn('Skipped feed entries that could not be read', {
      sourceId: source.id,
      failed: failures.length,
      of: entryCount,
      firstError: truncate(failures[0] ?? '', MAX_LOGGED_ERROR_CHARS),
    });
  } else if (entryCount > 0 && pairs.length === 0) {
    logger.warn('No feed entry had a usable link and date', {
      sourceId: source.id,
      entries: entryCount,
    });
  }
}
