import { extractFromXml, type FeedEntry } from '@extractus/feed-extractor';
import { errorMessage } from '../../shared/errors';
import { choicesOf, parseFeedDate, rawChoices } from './feedFields';
import { permanentFailure, statusFailure } from './http';
import type { RawEntry, SourceAdapter } from './pipeline';

// RSS 2.0 and Atom (W1-01). Parses only; the pipeline normalizes.

function parseEntries(xml: string, sourceId: string): FeedEntry[] {
  try {
    return (
      extractFromXml(xml, {
        // 0 turns off the library's own 250-char cut; the pipeline truncates.
        descriptionMaxLen: 0,
        // Keep the feed's own date text: the library would read a zone-less date in local time.
        useISODateFormat: false,
        getExtraEntryFields: (raw) => ({ ...rawChoices(raw) }),
      }).entries ?? []
    );
  } catch (error) {
    throw permanentFailure(`Cannot parse feed ${sourceId}: ${errorMessage(error)}`, error);
  }
}

/** The first date text that parses, best first. */
function firstDate(texts: readonly (string | undefined)[]): Date | undefined {
  for (const text of texts) {
    const date = text === undefined ? undefined : parseFeedDate(text);
    if (date) return date;
  }
  return undefined;
}

/**
 * One feed entry to a raw entry. A missing link or unreadable date becomes an empty value, so
 * the pipeline drops the entry and can say that a whole feed had none usable.
 */
function toRawEntry(entry: FeedEntry): RawEntry {
  const choices = choicesOf(entry);
  return {
    url: (choices.alternateUrl ?? entry.link ?? '').trim(),
    title: entry.title ?? '',
    text: choices.html ?? entry.description ?? '',
    publishedAt: firstDate([...(choices.dateTexts ?? []), entry.published]) ?? '',
    entryId: entry.id,
  };
}

export const rssAdapter: SourceAdapter = {
  kind: 'rss',

  async request(source, _window, get) {
    const reply = await get(source.url);
    if (!reply.ok) throw statusFailure(reply.status, source.id);
    return [reply];
  },

  parse(reply, source) {
    return parseEntries(reply.body, source.id).map(toRawEntry);
  },
};
