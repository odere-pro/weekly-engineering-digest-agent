// `sourceEval.ts` is the old import path of the source conformance check. This pins that the names
// callers outside `evals/sourceConformance/` import from it still reach the moved code.
import { describe, expect, it } from 'vitest';
import { conformanceProblems } from './sourceConformance/conformance/conformanceProblems';
import { evaluateSources } from './sourceConformance/conformance/evaluateSources';
import { loadSourceRecordings } from './sourceConformance/recordings/loadSourceRecordings';
import { defaultFetcherFactories } from './sourceConformance/replayFetch/fetcherFactories';
import { fetchFromRecording } from './sourceConformance/replayFetch/fetchFromRecording';
import * as bridge from './sourceEval';

describe('sourceEval bridges', () => {
  it('re-export the moved functions and values, not copies', () => {
    expect(bridge.conformanceProblems).toBe(conformanceProblems);
    expect(bridge.evaluateSources).toBe(evaluateSources);
    expect(bridge.loadSourceRecordings).toBe(loadSourceRecordings);
    expect(bridge.defaultFetcherFactories).toBe(defaultFetcherFactories);
    expect(bridge.fetchFromRecording).toBe(fetchFromRecording);
  });

  it('export nothing else at run time', () => {
    expect(Object.keys(bridge).toSorted()).toEqual([
      'conformanceProblems',
      'defaultFetcherFactories',
      'evaluateSources',
      'fetchFromRecording',
      'loadSourceRecordings',
    ]);
  });
});
