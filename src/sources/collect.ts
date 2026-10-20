import { ItemSchema, type Item, type Source, type SourceKind } from '../domain/schemas';
import type { FetchWindow, SourceFetcher } from './SourceFetcher';
import { causeChain } from '../shared/causeChain';
import type { Clock } from '../shared/clock';
import { mapWithConcurrency } from '../shared/concurrency';
import { errorMessage, FetchError } from '../shared/errors';
import { TimeoutError, withRetry, withTimeout } from '../shared/retry';
import type { Logger } from '../shared/telemetry';
import { truncate } from '../shared/text';

export interface CollectInput {
  sources: readonly Source[];
  since: Date;
  until: Date;
  maxItemsPerSource: number;
}

export interface CollectDeps {
  fetchers: Readonly<Partial<Record<SourceKind, SourceFetcher>>>;
  logger: Logger;
  clock: Clock;
  /** Per source. Spec: 10 s and 2 retries. */
  timeoutMs?: number;
  retries?: number;
  /**
   * The run's abort signal. Once it fires no fetch starts, the running ones are aborted, a back-off
   * ends, and `collectStep` rejects: a run told to stop is not a broken feed, so nothing is
   * listed in `failedSources`.
   */
  signal?: AbortSignal;
}

export interface CollectOutput {
  items: Item[];
  failedSources: { sourceId: string; error: string }[];
}

type FailedSource = CollectOutput['failedSources'][number];

interface SourceOutcome {
  items: Item[];
  /** How many items this source may add to the digest's pool. */
  maxItems: number;
  failure?: FailedSource;
}

/** Spec: 10 s timeout and 2 retries per source. */
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 500;
/** How many sources are fetched at once. `digest fetch` uses the same number. */
export const MAX_CONCURRENT_SOURCES = 4;
/** A fetcher's error text is untrusted and can be long: this much reaches logs and run records. */
const MAX_ERROR_CHARS = 300;

/** The text of an error as it may be logged or recorded. */
function cappedMessage(error: unknown): string {
  return truncate(errorMessage(error), MAX_ERROR_CHARS);
}
/**
 * Node's fetch reports every transport failure as a TypeError with one of these messages. Like
 * the Ollama adapter, any of them is retried, whatever the cause: a spent retry is cheaper than
 * a source lost for the week.
 */
const FETCH_FAILURE_MESSAGE = /^(?:fetch failed|terminated)$/;
/** Transport error codes, for failures that reach us without the TypeError wrapper. */
const NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/**
 * Fetches every allowlisted source (W1-03). A source that fails after its retries is listed in
 * `failedSources` and skipped; feed problems never make this step throw. Only `deps.signal`
 * firing does: the step then rejects as soon as the running fetches are aborted.
 */
export async function collectStep(input: CollectInput, deps: CollectDeps): Promise<CollectOutput> {
  const outcomes = await mapWithConcurrency(input.sources, MAX_CONCURRENT_SOURCES, (source) =>
    collectSource(source, input, deps),
  );
  const items = sortNewestFirst(mergeOutcomes(outcomes));
  const failedSources = outcomes.flatMap((outcome) => (outcome.failure ? [outcome.failure] : []));
  return { items, failedSources };
}

/** Rejects only when the run's signal fired; every other failure becomes a `failure`. */
async function collectSource(
  source: Source,
  input: CollectInput,
  deps: CollectDeps,
): Promise<SourceOutcome> {
  const maxItems = source.maxItems ?? input.maxItemsPerSource;
  try {
    const fetcher = deps.fetchers[source.kind];
    if (!fetcher) throw new Error(`No fetcher registered for kind "${source.kind}"`);
    const window: FetchWindow = { since: input.since, until: input.until, maxItems };
    const fetched = asList(await fetchWithRetry(fetcher, source, window, deps));
    const items = acceptItems(fetched, source, input, deps.logger);
    if (items.length === 0) {
      // A quiet week and a silently broken feed look alike here, so say it. Log only: the run
      // record has no field for it.
      deps.logger.warn('Source returned no usable items', {
        sourceId: source.id,
        fetched: fetched.length,
      });
    }
    return { items, maxItems };
  } catch (error) {
    // The run was told to stop: that is no broken feed, so it is neither logged nor recorded.
    if (deps.signal?.aborted) throw error;
    const message = cappedMessage(error);
    deps.logger.warn('Source failed', { sourceId: source.id, error: message });
    return { items: [], maxItems, failure: { sourceId: source.id, error: message } };
  }
}

function fetchWithRetry(
  fetcher: SourceFetcher,
  source: Source,
  window: FetchWindow,
  deps: CollectDeps,
): Promise<unknown> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return withRetry(
    () => withTimeout((signal) => fetcher.fetch(source, window, signal), timeoutMs, deps.signal),
    {
      signal: deps.signal,
      retries: deps.retries ?? DEFAULT_RETRIES,
      baseDelayMs: RETRY_BASE_DELAY_MS,
      shouldRetry: isRetryableFetchError,
      onRetry: (error, attempt) => {
        deps.logger.debug('Retrying source', {
          sourceId: source.id,
          retry: attempt + 1,
          error: cappedMessage(error),
        });
      },
    },
  );
}

/**
 * The fetchers say it themselves: a `FetchError` carries `retryable` (timeouts, 5xx, 408 and
 * 429 yes; other 4xx, a GitHub rate limit, a bad URL, a refused redirect or a feed that does
 * not parse no), and that answer is final. Of the rest, a timeout or a bare transport failure
 * from `fetch` can clear up on its own; anything else is a bug and fails fast. Mirrors
 * `isRetryable` in the Ollama adapter.
 */
function isRetryableFetchError(error: unknown): boolean {
  if (error instanceof FetchError) return error.retryable;
  return error instanceof TimeoutError || isNetworkFailure(error);
}

function isNetworkFailure(error: unknown): boolean {
  // The GitHub fetcher rebuilds a failure from message and name alone, so match the name too.
  const isFetchFailure =
    error instanceof Error &&
    error.name === 'TypeError' &&
    FETCH_FAILURE_MESSAGE.test(error.message);
  return isFetchFailure || causeChain(error).some(hasNetworkCode);
}

function hasNetworkCode(error: Error): boolean {
  return 'code' in error && typeof error.code === 'string' && NETWORK_ERROR_CODES.has(error.code);
}

function asList(fetched: unknown): unknown[] {
  if (!Array.isArray(fetched)) throw new Error('Fetcher did not return a list of items');
  return fetched;
}

/** Keeps schema-valid items inside `[since, until]`; the window check is defense in depth. */
function acceptItems(
  fetched: readonly unknown[],
  source: Source,
  input: CollectInput,
  logger: Logger,
): Item[] {
  const sinceMs = input.since.getTime();
  const untilMs = input.until.getTime();
  return fetched.flatMap((candidate: unknown) => {
    const parsed = ItemSchema.safeParse(candidate);
    if (!parsed.success) {
      logger.warn('Dropped invalid item', {
        sourceId: source.id,
        issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
      });
      return [];
    }
    const publishedMs = Date.parse(parsed.data.publishedAt);
    if (publishedMs < sinceMs || publishedMs > untilMs) {
      logger.debug('Dropped item outside the window', {
        sourceId: source.id,
        itemId: parsed.data.id,
      });
      return [];
    }
    return [parsed.data];
  });
}

/**
 * Sources are merged in config order, so the earliest source wins a duplicate. A source is cut
 * to its own cap only after its duplicates are gone, newest first. The fetchers already apply
 * the cap to what they return, so this is a second guard: a fetcher that returns more than it
 * was asked for cannot flood the pool, and a duplicate or capped-off item cannot crowd out a
 * real one.
 */
function mergeOutcomes(outcomes: readonly SourceOutcome[]): Item[] {
  const seen = new Set<string>();
  const merged: Item[] = [];
  for (const { items, maxItems } of outcomes) {
    const own = new Set<string>();
    const fresh = items.filter((item) => {
      if (seen.has(item.id) || own.has(item.id)) return false;
      own.add(item.id);
      return true;
    });
    for (const item of sortNewestFirst(fresh).slice(0, maxItems)) {
      seen.add(item.id);
      merged.push(item);
    }
  }
  return merged;
}

/** Stable: items with equal timestamps keep their collection order. */
function sortNewestFirst(items: readonly Item[]): Item[] {
  return items.toSorted((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
}
