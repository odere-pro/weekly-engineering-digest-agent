import { errorMessage } from '../../../src/shared/errors';
import type { SourceRecording } from '../recordings/types';
import type { SourceFetcherFactories } from '../replayFetch/fetcherFactories';
import { fetchFromRecording } from '../replayFetch/fetchFromRecording';
import { tally } from './tally';
import type { SourceResult } from './types';

async function evaluateOne(
  recording: SourceRecording,
  factories: SourceFetcherFactories,
): Promise<SourceResult> {
  try {
    return tally(recording, await fetchFromRecording(recording, factories));
  } catch (error) {
    return { ...tally(recording, []), error: errorMessage(error) };
  }
}

/** Runs the fetcher of each source's kind over its recording, one source at a time. */
export async function evaluateSources(
  recordings: readonly SourceRecording[],
  factories: SourceFetcherFactories,
): Promise<SourceResult[]> {
  const results: SourceResult[] = [];
  for (const recording of recordings) results.push(await evaluateOne(recording, factories));
  return results;
}
