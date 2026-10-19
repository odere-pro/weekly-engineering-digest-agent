import type { Item } from '../../../src/domain/schemas';
import type { FetchWindow } from '../../../src/sources/SourceFetcher';
import type { SourceRecording } from '../recordings/types';
import type { SourceFetcherFactories } from './fetcherFactories';
import { serveRecording } from './serveRecording';

/** Every recording is read with a window that holds all of its entries and the largest cap. */
export const EVERYTHING: FetchWindow = {
  since: new Date(0),
  until: new Date(8.64e15),
  maxItems: 100,
};

/** The items a source's fetcher yields from its recording, for a window that covers all of it. */
export function fetchFromRecording(
  recording: SourceRecording,
  factories: SourceFetcherFactories,
): Promise<Item[]> {
  const fetcher = factories[recording.source.kind](serveRecording(recording));
  return fetcher.fetch(recording.source, EVERYTHING);
}
