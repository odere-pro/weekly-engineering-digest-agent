# Result

## Intent

This folder turns one raw capture into the tuning result: the proposed thresholds, how they score
on the train and holdout sides, and whether they pass the spec gates. It is pure: no files, no
model calls. The result file is what the maintainer reads before changing a threshold.

## How it works

1. `tuneThresholds(raw, split?)` (`tune.ts`) splits the capture (default: two newest weeks and
   every third case held out), runs both sweeps on the train side and joins the picks as
   `proposed`.
2. It scores `proposed` on both sides (`scoreSide`), compares them (`compareSides`) and checks the
   week items against the maintainer's week labels (`weekCheck.ts`).
3. `acceptanceOf` (`acceptance.ts`) judges the train side against the gates: classifier accuracy,
   filter accuracy, the worst guard false-block rate, input false blocks in mode "any", and
   failed calls.
4. `TuningResultSchema` (`schema.ts`) is the shape of `<date>-<profile>.json`.
5. `summaryText` (`summary.ts`) is the text `sweep` prints: thresholds in use against proposed,
   the headline numbers, then train and holdout side by side.

## Design

- Every section of the result describes the train side. Only `split` and `scores` describe both.
  Both are optional, so results from before the split still parse.
- A rate that could not be measured is `null` and fails its gate. It is never 0 and never NaN.
- A failed call counts for the whole capture, not just the train side.
- The order of the keys in `tune.ts` and `acceptance.ts` is the order in the JSON file. `../committedTuning.test.ts`
  compares the committed result key for key.
- `METHOD` in `tune.ts` is written into the result so the file explains how it was made.

## Files

| File            | Role                                                                        |
| --------------- | --------------------------------------------------------------------------- |
| `schema.ts`     | `TuningResultSchema`, `TuningResult`, `WeekCheck`                           |
| `tune.ts`       | `tuneThresholds`                                                            |
| `weekCheck.ts`  | `weekCheck`: must-include kept, must-exclude dropped                        |
| `acceptance.ts` | `acceptanceOf`, `atLeast`, `atMost`                                         |
| `summary.ts`    | `summaryText`                                                               |
| `*.test.ts`     | One per file. `tune.test.ts` covers the split, nothing-to-measure and gates |

## Depends on, used by

Depends on: `../capture/schemas`, `../sweep/`, `../split.ts`, `src/config/schema`.
Used by: `../cli/sweepCommand.ts`, `../committedTuning.test.ts`.

## Change it safely

- Run `pnpm vitest run evals/thresholds/result`.
- A new field in the result needs an entry in `schema.ts` and, if old files lack it, `.optional()`.
- A new gate goes into `acceptanceOf` and `schema.ts`; its number comes from `GATES`, not a literal.
