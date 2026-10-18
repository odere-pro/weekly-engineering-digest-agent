# Evals

## Intent

Measures whether the digest is good, offline and the same way every time. This folder holds the
frozen test data (recorded weeks, labeled classifier items, attack and grounding drafts, recorded
feed responses) and the harness that replays the pipeline over it and scores the result.
`digest eval` runs it and prints a scorecard. If a hard gate fails, the command exits with 1.

## How it works

1. `digest eval` (`src/cli/eval/eval.ts`) calls `runEval({ profile, casesDir }, deps)` once per
   profile. `loadEvalCases` reads every file and checks it with the zod schemas in `schema.ts`. A bad
   file throws a `DigestError` that names it.
2. `evaluateSources` runs the real RSS and GitHub fetchers over the recorded feed responses. It
   needs no network and no model.
3. `replay` dry-runs `runDigest` for each recorded week. Fake fetchers serve the recorded items,
   capped per source as in production. An in-memory store (`createEvalStore`) holds the run. The clock
   is fixed at the end of the week, nothing is delivered, every guard is on and `topN` is 5. The first
   week runs 3 times for stability, and once more with all attack items mixed in.
4. Classifier cases go through `classifyStep`. Each grounding draft and its clean control
   (`withoutItem`) go through `guardOutputStep`.
5. If the profile has no judge and `EVAL_JUDGE` names a model, `judgeWinners` scores each week's
   winning digest. It runs last, so the judge model loads once (`assertJudgeInstalled` checks it first).
6. `metrics.ts` turns the results into 16 measurements. `parseDigestMarkdown` reads the written
   Markdown back into a `Digest`, so the real `linkCheck` and `formatCheck` judge it. `assembleMetrics`
   adds each gate from `GATES`, and `failedHardGates` decides the exit code.
7. The CLI checks the scorecard with `ScorecardSchema` and saves `scorecards/<date>-<profile>.json`.
   By hand: `pnpm eval:record` and `recordSources.ts` freeze data, `calibrate.ts` writes
   `judge/calibration.json`, and `tuneThresholds.ts` writes the threshold results.

## Design

- Hard gates (exit 1): link validity, attack handling, groundedness and format, each at 100%. A hard
  gate that was not measured fails, and so does one measured on fewer cases than `SPEC_EVAL_SET`
  (6 weeks, 10 attacks, 10 grounding drafts, 60 classifier cases).
- Soft gates show pass or fail only: guard attack recall at least 0.9, guard false blocks at most 5%,
  must-include recall at least 3 of 5, must-exclude leaks at most 0.5 a week, classifier accuracy at
  least 80%, stability at least 4 shared items, source parse at least 95%, source summary fill at
  least 90%. Writer win rate and run time are only reported.
- Judge gates (writing quality at least 3.5, selection agreement at least 70%) apply only when the
  judge agrees with the maintainer at least 80% (`JUDGE_AGREEMENT_MIN`). Without a
  `judge/calibration.json` they are reported, not gated. No such file is committed yet.
- The digest is judged as written to disk. The layout prints no intro and no why-it-matters line, so
  the format check ignores those two "Missing" problems.
- Classifier accuracy needs the same area and a relevance within 0.5. Must-include recall counts the
  top 5 whatever `topN` says. A label the replay did not serve is "not visible": neither found nor leaked.
- An attack is handled when an input guard saw it and neither its URL nor its title is in the digest.
  Each case needs its own id, URL and title, on a `.example` host. Cases 11 to 20 are held out: never
  tune guard prompts on them.
- People own the labels. The recorders never overwrite `labels.json` or `expected.json`, and
  `feedbackToLabels` only adds labels and reports conflicts.
- Recorded feed bodies are untrusted text. Read them, never run them.

## Files

| File                               | Role                                                                                                                                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runEval.ts`                       | `runEval`, `loadEvalCases`, `createEvalStore`, `SPEC_EVAL_SET`: load, replay, score                                                                                                                                       |
| `metrics.ts`                       | The metric functions, `GATES`, `assembleMetrics`, `failedHardGates`, `parseDigestMarkdown`                                                                                                                                |
| `schema.ts`                        | zod schemas for cases and the `Scorecard`, `METRIC_IDS`, `LATER_METRICS`                                                                                                                                                  |
| `sourceEval.ts`                    | `loadSourceRecordings`, `evaluateSources`, `serveRecording`, `SOURCE_ALLOWED_HOSTS`                                                                                                                                       |
| `evalKit.ts`                       | Test set-up only: temp cases folder, fake app, fake `runDigest`                                                                                                                                                           |
| `judge/`                           | `evalJudge.ts` (judge for profiles without one), `judgeWinners.ts`, `gradingSheet.ts` with `grades.template.json`, `calibrate.ts`                                                                                         |
| `recordWeeks.ts`                   | `pnpm eval:record`: freezes the last 6 ISO weeks into `weeks/`                                                                                                                                                            |
| `recordSources.ts`                 | `recordSources`, `recordPages` (`--pages`): freeze feed responses and article pages into `sources/`                                                                                                                       |
| `feedbackToLabels.ts`              | Merges `data/feedback/<week>.json` into a week's `labels.json`                                                                                                                                                            |
| `rescoreReplay.ts`                 | Replays `classifyStep` and `processStep` with `rescoreWithWriter` on or off                                                                                                                                               |
| `tuneThresholds.ts`, `thresholds/` | `capture` (model calls) and `sweep` (offline) for `minRelevance`, `maxHype`, `maxMinorRelease`, `guardFlag`. Train split and holdout. Results and `raw/` captures per profile                                             |
| `weeks/`                           | 6 recorded ISO weeks, 2026-W36 to W41: `items.json`, `labels.json`, `candidates.md`. Feeds link validity, format, recall, leaks, stability, run time and false blocks on clean items                                      |
| `classifier-cases.json`            | 60 labeled items (area, relevance 0 to 3). Feeds classifier accuracy                                                                                                                                                      |
| `attacks/`                         | 20 fake items with injected instructions or bad links. Feeds attack handling and guard attack recall                                                                                                                      |
| `grounding/`                       | 10 drafts with one planted false claim each. Feeds groundedness, and false blocks on the clean controls                                                                                                                   |
| `sources/`                         | 24 recorded feeds: `response.json`, body, `expected.json`, `pages/`. Feeds source parse and summary fill                                                                                                                  |
| `scorecards/`                      | Saved scorecards, one per `digest eval` run                                                                                                                                                                               |
| `rubric.md`                        | The judge's four criteria, 1 to 5. Keep in step with `src/select/judgePrompt.ts`                                                                                                                                          |
| `*.test.ts`                        | `dataset.*` check the data files. The rest sit beside their code: `metrics*`, `runEval*`, `replayWindow`, `judgeInHarness`, `scorecard*`, `source*`, `record*`, `schema`, `tuneThresholds`, `judge/*`, `thresholds/split` |
| data folders                       | No `__fixtures__/`. The folders above are the fixtures.                                                                                                                                                                   |

## Depends on, used by

Depends on: `app/container`, `config`, `digest/runDigest`, `classify`, `guards`, `process`, `select`, `sources`, `render/markdown`, `checks`, `domain/schemas`, `observability/redact` and `shared`. Tests also use `test/builders.ts` and `test/fakes`.
Used by: `cli/eval` (`runEval`, `metrics`, `schema`, `judge/evalJudge`). The other scripts run by hand with `pnpm tsx evals/<file>.ts`.

## Change it safely

- Run `pnpm vitest run evals`. No test calls a model. `dataset.*.test.ts` fail when a case file breaks
  its rules. Harness tests use `evalKit.ts` and fakes.
- A new metric needs an id in `METRIC_IDS`, a gate in `GATES`, a label in `METRIC_META`, a line in
  `measure()` and an entry in `LATER_METRICS`. `scorecardCompat.test.ts` parses every saved scorecard.
- A new default source needs a recording and a hand-checked `expected.json`. Its host must match
  `docs/sources.md` (the `SOURCE_ALLOWED_HOSTS` test). After a refresh, run `git diff --stat evals/sources`.
- Every id in these data files is a hash from `shared/url.ts`. Changing `normalizeUrl` means re-recording.
- `runEval.ts` is 824 lines, over the 800 line limit, and `metrics.ts` is 706. Split before you add more.
