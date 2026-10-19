# Sweep

## Intent

This folder picks the thresholds. Given the raw outputs of one capture, it searches a grid for the
value of each threshold that does best against our labels. It reads no file and calls no model.

## How it works

1. `grid.ts` lists the grid (`axisValues`, step 0.05: relevance 0 to 3, probabilities 0 to 1) and
   `pickOnGrid` scores every grid point with a function the caller gives.
2. `sweepFilter` (`filter.ts`) picks `minRelevance`, `maxHype` and `maxMinorRelease` together. The
   score is the number of classifier cases the filter keeps or drops as their label says: keep
   when the label is relevance 2 or 3 (`KEEP_MIN_LABEL`). It also reports the accuracy curve of
   each threshold, with the other two held at the chosen values.
3. `sweepGuardFlag` (`guardFlag.ts`) picks `guardFlag`: the value at which clefPolicy flags the
   most attacks, while clefPolicy (clean week items) and clefRubric (clean control drafts) each
   flag 5% or less. Granite gives verdicts, not probabilities, so `graniteResult` only reports it.
4. Failed calls are left out of every number and counted.

## Design

- Ties go to the grid point whose neighbours score best (2 steps on every axis,
  `MARGIN_STEPS`), then to the point closest to the thresholds in use. A small shift in model
  probabilities should not change the outcome, and nothing moves further than the data asks.
- A probability equal to `guardFlag` is not flagged, as in the clefPolicy guard.
- `keepsItem.ts` is the keep test the sweep scores with. It calls `passesThresholds` from
  `src/process/filter/thresholds.ts`, the process step's own rule, so the two cannot drift.
  `keepsItem.test.ts` still runs `processStep` on a table of items to pin that.
- `measures.ts` reads the gate numbers (false blocks at most 5%, classifier accuracy at least
  80%) from `GATES` in `evals/metrics.ts`, so the sweep and the scorecard cannot drift apart.
- `EPSILON` absorbs floating-point noise in every comparison of a score or a threshold.

## Files

| File           | Role                                                                             |
| -------------- | -------------------------------------------------------------------------------- |
| `grid.ts`      | `axisValues`, `RELEVANCE_AXIS`, `PROBABILITY_AXIS`, `pickOnGrid`, `MARGIN_STEPS` |
| `keepsItem.ts` | `keepsItem`, `FilterThresholds`: the process step's rules as one test            |
| `filter.ts`    | `sweepFilter`, `filterSamples`, `filterOutcome`, `KEEP_MIN_LABEL`                |
| `guardFlag.ts` | `sweepGuardFlag`, `guardSamples`, `guardFlagPoint`, `graniteResult`              |
| `measures.ts`  | `EPSILON`, `share`, `MAX_FALSE_BLOCK_RATE`, `MIN_CLASSIFIER_ACCURACY`            |
| `*.test.ts`    | One per file, on the small records in `../__fixtures__/records.ts`               |

## Depends on, used by

Depends on: `../capture/schemas` (the record types), `evals/metrics` (`GATES`), `evals/schema`
(the `Gate` type), `src/config/schema` (`Thresholds`), `src/shared/errors`.
Used by: `../split.ts` (outcome and flag points for the side scores), `../result/` (the sweeps, the
gates, the week check).

## Change it safely

- Run `pnpm vitest run evals/thresholds/sweep`. Then run `../committedTuning.test.ts`: the sweep
  on the committed capture must give the committed numbers.
- Changing the grid, `MARGIN_STEPS` or the tie rules changes the proposed thresholds. Treat it as
  a method change: re-run `sweep`, update the README table.
- Changing a rule in `keepsItem.ts` without `src/process` fails `keepsItem.test.ts` on purpose.
