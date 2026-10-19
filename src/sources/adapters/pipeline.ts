import type { Source, SourceKind } from '../../domain/schemas';
import { DEFAULT_SOURCES } from '../defaultSources';
import type { FetchWindow, SourceFetcher } from '../SourceFetcher';
import { noopLogger, type Logger } from '../../shared/telemetry';
import { enrichEntries } from './enrich';
import { mergeEnriched } from './entries/mergeEnriched';
import { readEntries, reportUnusable } from './entries/readEntries';
import { selectEntries } from './entries/selectEntries';
import type { RawEntry } from './entries/types';
import { getText, sameSiteAs, type Answer, type Reply } from './http';

// The shared path of every source: an adapter requests its vendor's response and parses it into
// raw entries; everything after that is the same for all of them (normalize, validate, window,
// sort, cap, and the article-page enrichment of entries that came without text). The entry steps
// live in `entries/`; this file wires them to the adapter, the HTTP reader and the debug tap.

const DEFAULT_MAX_SUMMARY_CHARS = 600;

export interface GetInit {
  headers?: Record<string, string> | undefined;
  maxBytes?: number | undefined;
  signal?: AbortSignal | undefined;
}

/** One GET through `http.ts`: same-site redirects only, body capped, errors name the source. */
export type Get = (url: string, init?: GetInit) => Promise<Reply>;

export interface SourceAdapter {
  readonly kind: SourceKind;
  /** Hosts besides the source's own that a redirect may reach (an API host). */
  readonly redirectHosts?: readonly string[];
  /** False when a page would add nothing the response lacks. Default true. */
  readonly enrichable?: boolean;
  request(source: Source, window: FetchWindow, get: Get): Promise<Reply[]>;
  /** Throws a `FetchError` when the whole response is unusable. */
  parse(reply: Reply, source: Source): RawEntry[];
}

/** The final answer to a request a source made for its feed or API, with the source's id. */
export interface SourceAnswer extends Answer {
  sourceId: string;
}

/** How the entries of a source's response were read. */
export interface SourceEntries {
  sourceId: string;
  /** Entries the adapter handed over. */
  parsed: number;
  /** Of those, how many could not become an item: no usable link or date, or invalid. */
  skipped: number;
}

/**
 * A debug tap for `digest fetch` (W8-06): sees the raw answers and the entry counts of a
 * source, and does not alter what is fetched. Its listeners must not throw. Off by default; a
 * run never builds a fetcher with one. Article pages fetched to fill in missing text are not
 * reported, only the source's own requests.
 */
export interface SourceTap {
  answer?: (event: SourceAnswer) => void;
  entries?: (event: SourceEntries) => void;
}

export interface FetcherOptions {
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof fetch;
  /** Summary length cap in characters. */
  maxSummaryChars?: number;
  /** Where an entry that had to be skipped is reported. */
  logger?: Logger;
  /** Fetch the entry page when the response carries no text. Default true. */
  enrich?: boolean;
  /**
   * Hostnames an article page may redirect to, besides the feed's own host: the collection
   * allowlist. Defaults to the hosts of `DEFAULT_SOURCES`.
   */
  collectionHosts?: readonly string[];
  /** Debug tap, see `SourceTap`. Never set by a run. */
  tap?: SourceTap;
}

/** The hostnames of these sources, for the redirect rule of article pages. */
export function hostsOf(sources: readonly Pick<Source, 'url'>[]): string[] {
  return [...new Set(sources.map(({ url }) => new URL(url).hostname.toLowerCase()))];
}

/** What a `Get` needs from the fetcher and the source it serves. */
interface GetterContext {
  fetchImpl: typeof fetch;
  source: Source;
  signal: AbortSignal | undefined;
}

/** A `Get` for one source: redirects go only where `allowed` says; `onAnswer` is the debug tap. */
function getterFor(
  { fetchImpl, source, signal }: GetterContext,
  allowed: (hostname: string) => boolean,
  onAnswer?: (answer: Answer) => void,
): Get {
  return (url, init = {}) =>
    getText(url, {
      fetch: fetchImpl,
      label: source.id,
      allowsRedirectTo: allowed,
      headers: init.headers,
      maxBytes: init.maxBytes,
      signal: init.signal ?? signal,
      onAnswer,
    });
}

/** The tap's answer listener, told whose answer it is; undefined without a tap. */
function answerListener(
  tap: SourceTap | undefined,
  sourceId: string,
): ((answer: Answer) => void) | undefined {
  const report = tap?.answer;
  return (
    report &&
    ((answer) => {
      report({ sourceId, ...answer });
    })
  );
}

/** Wraps an adapter into the `SourceFetcher` port. */
export function createFetcher(adapter: SourceAdapter, options: FetcherOptions = {}): SourceFetcher {
  const fetchImpl: typeof fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const maxChars = options.maxSummaryChars ?? DEFAULT_MAX_SUMMARY_CHARS;
  const logger = options.logger ?? noopLogger;
  const collectionHosts = options.collectionHosts ?? hostsOf(DEFAULT_SOURCES);
  const shouldEnrich = (options.enrich ?? true) && adapter.enrichable !== false;

  return {
    kind: adapter.kind,
    async fetch(source, window, signal) {
      const context: GetterContext = { fetchImpl, source, signal };
      const redirectHosts = adapter.redirectHosts ?? [];
      // Only the source's own requests are tapped, not the article pages below.
      const get = getterFor(
        context,
        sameSiteAs(source.url, ...redirectHosts),
        answerListener(options.tap, source.id),
      );
      // An article page may be moved to another collected site (deepmind.google to blog.google).
      const getPage = getterFor(
        context,
        sameSiteAs(source.url, ...redirectHosts, ...collectionHosts),
      );

      const replies = await adapter.request(source, window, get);
      const entries = replies.flatMap((reply) => adapter.parse(reply, source));
      const reading = readEntries(entries, source, maxChars);
      reportUnusable(logger, source, entries.length, reading);
      options.tap?.entries?.({
        sourceId: source.id,
        parsed: entries.length,
        skipped: entries.length - reading.pairs.length,
      });

      const selected = selectEntries(reading.pairs, source, window, maxChars);
      if (!shouldEnrich) return selected.map(({ item }) => item);

      const enriched = await enrichEntries(
        selected.map(({ entry }) => entry),
        source,
        { get: getPage, logger, signal },
      );
      return mergeEnriched(enriched, selected, source, maxChars);
    },
  };
}
