# Digest run

## Intent

This feature runs one weekly digest from start to end. It chains the steps and decides how the
week ends: sent, dry-run, skipped, quiet, blocked or failed. It saves the run record and files,
sends failure notes, and finishes a week that was only partly delivered, with no model call.

## How it works

1. `runDigest(deps, options)` (`runDigest.ts`) resolves the week id, the window in days, the
   dry-run flag and the abort signal. A bad week id or a window under 1 day throws `DigestError`.
2. It returns `skipped` when the store already has a sent digest for the week (unless `force`).
   It then takes the run lock and reads the week's record again under the lock.
3. Unless `force` or `dryRun`, `loadPartDelivery` (`runResume.ts`) looks for a failed record that
   already reached some channel. If found, `resumeDelivery` sends the saved digest.md to the
   missing channels only, and the run ends there.
4. Otherwise `runChain` checks the signal and `assertModelsReady` (Ollama reachable, every model
   in use pulled). `runWorkflow` (`workflow.ts`) then runs the stages in order: collect,
   guardInput, classify, process, write, guardOutput, select, deliver. A dry run has no deliver.
5. A stage can settle the run early. `quiet`: no items collected, or fewer than
   `DIGEST_MIN_ITEMS` (3) left after process. `blocked`: every draft was rejected and the fallback is off (`noFallback`) or failed its checks.
6. `finish` builds the `RunRecord` and calls `endRun` (`runEnding.ts`): save the record, write
   held files, `review.md`, `error.json`, send or hold the failure note, prune old runs.
7. It returns `RunResult` (`record`, `exitCode`, `markdown`, `message`, `kept`) and releases the
   lock in `finally`.

## Design

- This folder only wires steps. The steps live in their own features. `workflow.ts` is the only
  file that imports Mastra (`@mastra/core` 1.78.0, pinned). It rethrows a step's own error so a
  `DigestError` keeps its exit code and step. It uses the internal `__setLogger`: re-check it
  when the pin moves.
- State is immutable. Each stage returns a new `ChainState`. A failing stage throws `StepFailure`
  (or `PartialFailure` after partial work) with the state so far, so the record keeps what ran.
- The abort signal is checked before each stage and before a resume's delivery, never inside
  one. A running stage finishes first.
- A run never replaces a record that got further (`keepReason`). A sent record stays unless the
  new run is sent too. A partly delivered record stays unless the new run also reached a channel.
  While the earlier record has reached a channel (`holdArtifacts`), this run's files wait in
  `ChainState.held` and `endRun` writes them only if its own record is saved.
- Resume refuses, with a message that contains `--force`, when digest.md is gone or its links
  differ from `previous.sentUrls`. `needsForce` and `isUnretriable` read that text.
- Failure notes: `notifyFailure` defaults to true. False holds the note for a caller that will
  retry (the scheduler); `sendHeldNote` sends it later. The note is sent anyway for an aborted
  run or a `--force`-only failure. A dry run sends none. If the record cannot be saved, `endRun`
  sends a note and throws `RecordNotSavedError`.
- No model or feed text in notes, records or errors. A write failure names writers only. A
  blocked note names writers and check ids.
- `shipDigest` tries every channel and never throws. Once any channel took the digest, its URLs
  count as sent for cross-week dedupe.
- Fallback floor (W11-02): when no draft passes the checks and the output guards, `buildFallback`
  (`fallback.ts`) makes a digest from the selected items' own text, no model call. It passes the
  same link and format checks (a failure is logged as an error and the week stays `blocked`). The
  output guards run on it once and only advise: a flag is logged and kept in `record.drafts` (writer
  `fallback`), never blocking. The run ends `sent` or `dry-run` with `record.fallback: true`, and the
  footer says "Written from the sources' own words." A real run always has it (no config switch);
  `RunOptions.noFallback` turns it off for tests and for the eval replay to set (the replay is W11-01's file). A write step where every
  writer produced no draft at all still ends `failed`: that is a model fault, not a rejected draft.
- The judge runs only when the profile has one and 2 or more drafts passed. Otherwise the first
  passing draft in writer order wins.
- Best effort, logged and never fatal: `review.md`, `error.json`, held-file writes, pruning.
- Exit codes come from `exitCodeFor`: sent, dry-run and skipped 0; failed 1; blocked 2; quiet 3.

## Files

| File           | Role                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------ |
| `runDigest.ts` | `runDigest`, `DigestDeps`, `RunOptions`, `RunResult`, the stages and the record            |
| `runEnding.ts` | `endRun`, `shipDigest`, `digestMessage`, `toJson`, `abortedError`, failure notes           |
| `runResume.ts` | `loadPartDelivery`, `resumeDelivery`: finish a partly delivered week                       |
| `fallback.ts`  | `buildFallback`: the template-only digest, its checks and guard verdict                    |
| `workflow.ts`  | `runWorkflow`: chains plain step functions as one Mastra workflow                          |
| `*.test.ts`    | One file per area, see below. No `__fixtures__/` here: tests use `test/fakes` and builders |

## Depends on, used by

Depends on: `domain`, `config`, `shared`, `models`, `store`, `delivery`, `sources`, `guards`,
`classify`, `process`, `write`, `select`, `checks`, `render`.
Used by: `app/container` (the `DigestDeps` type), `scheduler`, `cli` (run, serve, eval, show,
preview, fetch), `evals/`, `test/integration`, `test/live`.

## Change it safely

- Tests: `runDigest.test.ts` (dry run, sent, skipped, quiet, failures), `runDigest.semantics.test.ts`
  (resume, per-channel delivery, held files), `runDigest.run.test.ts` (health check, abort),
  `runDigest.notify.test.ts`, `runEnding*.test.ts`, `runResume*.test.ts`, `workflow.test.ts`.
  Cross-feature runs are in `test/integration/`.
- Stage `process` runs `selectItems`, and stage `select` runs `pickWinner`. The names differ.
- `skipped` returns a record that is not saved. `markdown` is set only when this run wrote
  digest.md. `message` is set whenever a draft won, a dry run too.
- The writer retry, and the calls to the link and format checks (`src/checks`), live in
  `src/write`. `runDigest.retry.test.ts` only tests them through a run.
- Do not import adapters, `node:fs` or network code here (ESLint fails the build).
- `runDigest.ts` is about 700 lines. Split it before it grows past 800.
- A new step needs a name in `StepNameSchema` (`src/domain/schemas.ts`) and a stage in `chainSteps`.
