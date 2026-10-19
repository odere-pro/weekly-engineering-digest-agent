# Threshold tuning

## Intent

This feature sets four numbers from our own labeled data instead of by guess: `minRelevance`,
`maxHype`, `maxMinorRelease` and `guardFlag`. The models are called once per profile (`capture`).
Every later question is answered offline from those saved outputs (`sweep`), so it is cheap to
repeat and gives the same answer every time. `evals/tuneThresholds.ts` is the command line.
`README.md` has the method, the measured results and how to read them.

## How it works

1. `capture` (`capture/`) classifies the 60 classifier cases and every recorded week item, asks
   clefPolicy and granite about every week item and attack, and asks clefRubric about every
   grounding draft and its clean control. It saves one raw file, `raw/<date>-<profile>.json`.
2. `sweep` (`cli/sweepCommand.ts`) reads that file and splits it (`split.ts`): the two newest
   weeks, and every third classifier case, attack and grounding case, are held out.
3. The sweeps (`sweep/`) pick the three classifier thresholds and `guardFlag` on the train side
   only, by grid search with step 0.05.
4. `result/tune.ts` scores the picked thresholds on both sides, checks them against the spec
   gates and builds the result. `cli/` writes it to `<date>-<profile>.json` and prints a summary.

## Design

- Capture is the only step that calls a model. A failed call is saved as `{ error }`, never lost,
  and a capture with failed calls exits 1. Sweep, split and result are pure.
- The holdout never reaches the pick. The result file describes the train side; `scores` holds
  both sides and the gap, and a gap above 0.1 adds a warning.
- Files from before the split (W6-04) have no `split` or `scores` and still parse.
- `sweep/keepsItem.ts` repeats the process step's three threshold rules. A test runs both on a
  table of items, so a rule change in `src/process` fails here.
- `evals/calibrate.ts` and `evals/rescoreReplay.ts` reuse the raw capture and the split. Their
  imports are the public surface: `capture.ts` (a bridge, see below) and `split.ts`.
- `capture.ts` next to the `capture/` folder is a bridge for `calibrate.ts` (W10-B23 removes it).
- `raw/` and `<date>-<profile>.json` are data. Never edit them by hand; a new capture adds a file.

## Files

| Path                      | Role                                                                                                       |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `capture/`                | The raw-capture schema and the capture run. See `capture/CLAUDE.md`                                        |
| `sweep/`                  | Grid search, the classifier sweep, the guardFlag sweep. See `sweep/CLAUDE.md`                              |
| `result/`                 | The result schema, `tuneThresholds`, acceptance checks, summary. See `result/CLAUDE.md`                    |
| `cli/`                    | The two commands, the files they write, the capture session. See `cli/CLAUDE.md`                           |
| `split.ts`                | Train and holdout split, side scores, the gap and its warnings (`split.test.ts`)                           |
| `capture.ts`              | Bridge: `RawCaptureSchema`, `isFailed`, `RawCapture` for `evals/calibrate.ts`                              |
| `committedTuning.test.ts` | Drift guard: sweep on the committed `raw/` file gives the committed result                                 |
| `__fixtures__/`           | Test records (`records.ts`), a scripted model with an eval set (`captureKit.ts`), a fake app (`appKit.ts`) |
| `raw/`, `*.json`          | Data: raw captures and sweep results per profile. No `CLAUDE.md` needed                                    |
| `README.md`               | Method, profiles, measured results, the 80% gate, the split and its numbers                                |

## Depends on, used by

Depends on: `src/classify` (capture), `src/guards` (the `InputGuard` and `OutputGuard` types),
`src/config/schema`, `src/domain/schemas`, `src/shared`, `evals/metrics` (`GATES`,
`classifierAccuracy`), `evals/schema`, `evals/runEval` (the `EvalCases` type). `cli/session.ts`
uses the `AppHandle` type of `src/app/container`.
Used by: `evals/tuneThresholds.ts`, `evals/calibrate.ts` (raw capture, split), `evals/rescoreReplay.ts`
(`CASE_STRIDE`, `parseHoldoutWeeks`).

## Change it safely

- Run `pnpm vitest run evals/tuneThresholds evals/thresholds`. No test calls a model.
- `committedTuning.test.ts` fails when any number or key of the committed result changes. If a
  change is meant, re-run `sweep` on the committed raw file, review `git diff`, and update the
  README table.
- Changing a threshold rule in `src/process` means changing `sweep/keepsItem.ts` too.
- Changing the raw schema breaks every saved capture. Add fields as optional.
- Every folder here has its own `CLAUDE.md` with the details.
