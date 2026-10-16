import { ItemSchema, type Item, type Source, type SourceKind } from '../schemas.js';
import type { FetchWindow, SourceFetcher } from '../../ports/SourceFetcher.js';
import type { Clock } from '../../shared/clock.js';
import { errorMessage } from '../../shared/errors.js';
import { withRetry, withTimeout } from '../../shared/retry.js';
import type { Logger } from '../../shared/telemetry.js';

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
}

export interface CollectOutput {
  items: Item[];
  failedSources: { sourceId: string; error: string }[];
}

type FailedSource = CollectOutput['failedSources'][number];

interface SourceOutcome {
  items: Item[];
  failure?: FailedSource;
}

/** Spec: 10 s timeout and 2 retries per source. */
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 500;
const MAX_CONCURRENT_SOURCES = 4;

/**
 * Fetches every allowlisted source (W1-03). A source that fails after its retries is listed in
 * `failedSources` and skipped; feed problems never make this step throw.
 */
export async function collectStep(input: CollectInput, deps: CollectDeps): Promise<CollectOutput> {
  const outcomes = await mapWithConcurrency(input.sources, MAX_CONCURRENT_SOURCES, (source) =>
    collectSource(source, input, deps),
  );
  const items = sortNewestFirst(dedupeById(outcomes.flatMap((outcome) => outcome.items)));
  const failedSources = outcomes.flatMap((outcome) => (outcome.failure ? [outcome.failure] : []));
  return { items, failedSources };
}

/** Never rejects: every failure becomes a `failure` on the outcome. */
async function collectSource(
  source: Source,
  input: CollectInput,
  deps: CollectDeps,
): Promise<SourceOutcome> {
  try {
    const fetcher = deps.fetchers[source.kind];
    if (!fetcher) throw new Error(`No fetcher registered for kind "${source.kind}"`);
    const window: FetchWindow = {
      since: input.since,
      until: input.until,
      maxItems: source.maxItems ?? input.maxItemsPerSource,
    };
    const fetched = await fetchWithRetry(fetcher, source, window, deps);
    return { items: acceptItems(fetched, source, input, deps.logger) };
  } catch (error) {
    const message = errorMessage(error);
    deps.logger.warn('Source failed', { sourceId: source.id, error: message });
    return { items: [], failure: { sourceId: source.id, error: message } };
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
    () => withTimeout((signal) => fetcher.fetch(source, window, signal), timeoutMs),
    {
      retries: deps.retries ?? DEFAULT_RETRIES,
      baseDelayMs: RETRY_BASE_DELAY_MS,
      onRetry: (error, attempt) => {
        deps.logger.debug('Retrying source', {
          sourceId: source.id,
          retry: attempt + 1,
          error: errorMessage(error),
        });
      },
    },
  );
}

/** Keeps schema-valid items inside `[since, until]`; the window check is defense in depth. */
function acceptItems(
  fetched: unknown,
  source: Source,
  input: CollectInput,
  logger: Logger,
): Item[] {
  if (!Array.isArray(fetched)) throw new Error('Fetcher did not return a list of items');
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

/** First occurrence wins, so sources earlier in the config take precedence. */
function dedupeById(items: readonly Item[]): Item[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

/** Stable: items with equal timestamps keep their collection order. */
function sortNewestFirst(items: readonly Item[]): Item[] {
  return items.toSorted((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
}

/** Runs `fn` over `inputs` with at most `limit` in flight; results keep the input order. */
async function mapWithConcurrency<T, R>(
  inputs: readonly T[],
  limit: number,
  fn: (input: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(inputs.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < inputs.length) {
      const index = nextIndex++;
      results[index] = await fn(inputs[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, inputs.length) }, () => worker()));
  return results;
}
