import { ItemSchema, type Item, type Source, type SourceKind } from '../schemas.js';
import type { FetchWindow, SourceFetcher } from '../../ports/SourceFetcher.js';
import type { Clock } from '../../shared/clock.js';
import { errorMessage } from '../../shared/errors.js';
import { TimeoutError, withRetry, withTimeout } from '../../shared/retry.js';
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
const FIRST_SERVER_ERROR = 500;
const MAX_CAUSE_DEPTH = 5;
/**
 * How both source fetchers word a non-2xx answer: "HTTP 503 fetching <id>", or a GitHub rate
 * limit, "... (HTTP 403)". Anchored so a status quoted inside a parse error is not mistaken for one.
 */
const HTTP_STATUS = /(?:^|\()HTTP (\d{3})\b/;
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
      shouldRetry: isRetryableFetchError,
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

/**
 * Timeouts, network failures and 5xx can clear up on their own. A 4xx (including a GitHub rate
 * limit), a bad URL or a feed that does not parse fails the same way again, so those fail fast.
 * Mirrors `isRetryable` in the Ollama adapter; the fetchers report an HTTP status in their
 * message, not as a field.
 */
function isRetryableFetchError(error: unknown): boolean {
  if (error instanceof TimeoutError) return true;
  const status = HTTP_STATUS.exec(errorMessage(error))?.[1];
  if (status !== undefined) return Number(status) >= FIRST_SERVER_ERROR;
  return isNetworkFailure(error);
}

function isNetworkFailure(error: unknown): boolean {
  // The GitHub fetcher rebuilds a failure from message and name alone, so match the name too.
  const isFetchFailure =
    error instanceof Error &&
    error.name === 'TypeError' &&
    FETCH_FAILURE_MESSAGE.test(error.message);
  return isFetchFailure || causeChain(error).some(hasNetworkCode);
}

function causeChain(error: unknown): Error[] {
  const chain: Error[] = [];
  for (let current = error; current instanceof Error && chain.length < MAX_CAUSE_DEPTH;) {
    chain.push(current);
    current = current.cause;
  }
  return chain;
}

function hasNetworkCode(error: Error): boolean {
  return 'code' in error && typeof error.code === 'string' && NETWORK_ERROR_CODES.has(error.code);
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
