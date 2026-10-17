import type { SourceFetcher } from '../../ports/SourceFetcher.js';
import type { Logger } from '../../shared/telemetry.js';
import { createFetcher } from './pipeline.js';
import { rssAdapter } from './rssAdapter.js';

export interface RssFetcherOptions {
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof fetch;
  /** Summary length cap in characters. */
  maxSummaryChars?: number;
  /** Where an entry that had to be skipped is reported. */
  logger?: Logger;
}

/** RSS and Atom feeds (W1-01). */
export function createRssFetcher(options: RssFetcherOptions = {}): SourceFetcher {
  return createFetcher(rssAdapter, options);
}
