# Capture

## Intent

This folder holds the raw outputs the threshold sweep works from, and the run that fills them. It
calls each model once per subject and keeps the answers, so nothing later needs a model.

## How it works

1. `captureRaw(set, deps)` (`captureRaw.ts`) refuses a classifier file the maintainer has not
   reviewed. Then it runs five phases, one model call at a time, in this order: classifier cases,
   week items, clefPolicy on week items and attacks, clefRubric on grounding drafts, granite on
   week items and attacks. The decision model loads once, then granite.
2. `subjects.ts` says what is asked: `guardSubjects` (every week item as `clean`, then every
   attack) and `draftSubjects` (each grounding draft, then its control without the planted item).
3. `calls.ts` makes the four calls for one subject: classify, clefPolicy, granite, clefRubric.
4. `runner.ts` walks the subjects (`inTurn`), turns a thrown call into `{ error }` (`attempt`),
   logs progress every 10 subjects and times each phase (`timed`).
5. It returns the records and `timingsMs` per phase. `schemas.ts` checks the file they go into.

## Design

- A failed call never stops the run. Its message is saved, and `failedCalls` / `totalFailed` count
  them so the command can exit 1 while keeping the file.
- A guard verdict without a probability is a failed call, not a zero: the sweep needs P(yes).
- `timed` uses wall-clock time and never returns a negative duration.
- The order of phases and the keys of every record are the file layout. Old raw files must keep
  parsing, so add fields as optional.
- `calls.ts` and `runner.ts` take narrow deps (`ItemCallDeps`, a `Clock`, a progress function).
  Only `captureRaw.ts` knows `CaptureDeps`.

## Files

| File            | Role                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------ |
| `schemas.ts`    | `RawCaptureSchema`, the record types, `isFailed`, `failedCalls`, `totalFailed`             |
| `subjects.ts`   | `EvalSet`, `guardSubjects`, `draftSubjects`, `labelOf`                                     |
| `calls.ts`      | `ItemCallDeps`, `classifyItem`, `policyProbability`, `graniteVerdict`, `rubricProbability` |
| `runner.ts`     | `attempt`, `inTurn`, `timed`, `Progress`                                                   |
| `captureRaw.ts` | `captureRaw`, `CaptureDeps`: the five phases                                               |
| `*.test.ts`     | One per file. `captureRaw.test.ts` runs the whole capture on a scripted model              |

Test records and the scripted model live in `../__fixtures__/`.

## Depends on, used by

Depends on: `src/classify/classify`, `src/guards/Guard`, `src/models/ModelProvider`,
`src/domain/schemas`, `src/config/schema`, `src/shared`, `evals/schema`, `evals/runEval` (type).
Used by: `../cli/` (the capture command and `readRaw`), `../sweep/`, `../split.ts`, `../result/`,
and `evals/calibrate.ts` through the bridge `../capture.ts`.

## Change it safely

- Run `pnpm vitest run evals/thresholds/capture`.
- Renaming a record key or a phase breaks every file in `../raw/`. `../committedTuning.test.ts`
  compares a fresh capture's keys with the committed one.
- Keep calls one at a time: Ollama holds one model at a time on this machine.
