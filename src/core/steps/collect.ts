import type { Item, Source, SourceKind } from '../schemas.js';
import type { SourceFetcher } from '../../ports/SourceFetcher.js';
import type { Clock } from '../../shared/clock.js';
import { NotImplementedError } from '../../shared/errors.js';
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

/** Fetches every allowlisted source (W1-03). */
export function collectStep(_input: CollectInput, _deps: CollectDeps): Promise<CollectOutput> {
  throw new NotImplementedError('W1-03');
}
