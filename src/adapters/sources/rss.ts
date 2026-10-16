import type { SourceFetcher } from '../../ports/SourceFetcher.js';
import { NotImplementedError } from '../../shared/errors.js';

export interface RssFetcherOptions {
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof fetch;
  /** Summary length cap in characters. */
  maxSummaryChars?: number;
}

/** RSS and Atom feeds (W1-01). */
export function createRssFetcher(_options: RssFetcherOptions = {}): SourceFetcher {
  throw new NotImplementedError('W1-01');
}
