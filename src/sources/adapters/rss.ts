import type { SourceFetcher } from '../SourceFetcher';
import type { Logger } from '../../shared/telemetry';
import { createFetcher, type SourceTap } from './pipeline';
import { rssAdapter } from './rssAdapter';

export interface RssFetcherOptions {
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof fetch;
  /** Summary length cap in characters. */
  maxSummaryChars?: number;
  /** Where an entry that had to be skipped is reported. */
  logger?: Logger;
  /** Sees each raw answer, see `SourceTap`: a run archives them (`archive/`). */
  tap?: SourceTap;
}

/** RSS and Atom feeds (W1-01). */
export function createRssFetcher(options: RssFetcherOptions = {}): SourceFetcher {
  return createFetcher(rssAdapter, options);
}
