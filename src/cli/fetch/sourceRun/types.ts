import type { Item, Source, SourceKind } from '../../../domain/schemas';
import type { Clock } from '../../../shared/clock';
import type { FetchWindow, SourceFetcher } from '../../../sources/SourceFetcher';
import type { SourceEntries } from '../../../sources/adapters/pipeline';
import type { Recorder } from './recorder';

/** What one source came to. */
export interface SourceReport {
  source: Source;
  ok: boolean;
  items: Item[];
  httpStatus: number | undefined;
  /** The URL that gave the last answer, after redirects. */
  answeredBy: string | undefined;
  /** Entries the adapter found and how many of them could not become items; undefined if unread. */
  entries: SourceEntries | undefined;
  durationMs: number;
  error: string | undefined;
}

/** What the command needs to fetch one source. */
export interface FetchRun {
  fetchers: Readonly<Record<SourceKind, SourceFetcher>>;
  recorder: Recorder;
  window: Pick<FetchWindow, 'since' | 'until'>;
  maxItemsPerSource: number;
  clock: Clock;
  timeoutMs: number;
  /** Takes the secrets out of a text. */
  redact: (text: string) => string;
}
