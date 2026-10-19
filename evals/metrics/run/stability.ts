import { measured, type Measurement } from '../measurement/measurement';
import { mean } from '../measurement/numbers';

/**
 * Mean number of items two runs of the same week have in common, over every pair of runs. The
 * item ids of each run are kept, and detail counts the runs and the empty ones: a 0 can mean
 * runs that picked different items or runs that produced nothing. `weekId`, the week that
 * was repeated, goes into the note.
 */
export function stability(runs: readonly (readonly string[])[], weekId?: string): Measurement {
  const overlaps = runs.flatMap((a, i) =>
    runs.slice(i + 1).map((b) => new Set(a.filter((id) => b.includes(id))).size),
  );
  if (runs.length === 0) return measured(null);
  return {
    value: mean(overlaps),
    detail: { runs: runs.length, emptyRuns: runs.filter((run) => run.length === 0).length },
    itemIdsByRun: runs.map((run) => [...run]),
    ...(weekId === undefined ? {} : { note: `overlap of ${runs.length} runs of ${weekId}` }),
  };
}
