// The source conformance check lives in evals/sourceConformance/ (see its CLAUDE.md). This file is
// only the old import path, for callers outside that folder; it holds no code of its own.
export { conformanceProblems } from './sourceConformance/conformance/conformanceProblems'; // compat (W10-B23): remove when callers move
export { evaluateSources } from './sourceConformance/conformance/evaluateSources'; // compat (W10-B23): remove when callers move
export type { SourceResult } from './sourceConformance/conformance/types'; // compat (W10-B23): remove when callers move
export { loadSourceRecordings } from './sourceConformance/recordings/loadSourceRecordings'; // compat (W10-B23): remove when callers move
export type { SourceRecording } from './sourceConformance/recordings/types'; // compat (W10-B23): remove when callers move
export {
  defaultFetcherFactories,
  type SourceFetcherFactories,
} from './sourceConformance/replayFetch/fetcherFactories'; // compat (W10-B23): remove when callers move
export { fetchFromRecording } from './sourceConformance/replayFetch/fetchFromRecording'; // compat (W10-B23): remove when callers move
