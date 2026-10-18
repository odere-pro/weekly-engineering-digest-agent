import type { Item, Source, SourceKind } from '../domain/schemas';

export interface FetchWindow {
  since: Date;
  until: Date;
  /** Keep at most this many items, newest first. */
  maxItems: number;
}

/**
 * Fetches one source once. Timeouts and retries are applied by the collect step;
 * the fetcher must honor `signal` and throw on HTTP or parse errors.
 */
export interface SourceFetcher {
  readonly kind: SourceKind;
  fetch(source: Source, window: FetchWindow, signal?: AbortSignal): Promise<Item[]>;
}
