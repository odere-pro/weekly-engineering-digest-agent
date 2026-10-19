# Evals

> Replays the recorded weeks and labeled cases through the pipeline, offline, and scores the result.
> Entry: `runEval(options, deps) → SavedScorecard` (`runEval.ts`, which only orders the work);
> `EvalDeps` injects `buildApp`, `runDigest`, clock.

## Context

```mermaid
flowchart LR
  cli["digest eval (cli)"] -->|"EvalOptions, EvalDeps"| evals["evals: runEval, metrics"]:::focus
  data[("weeks, cases, attacks, grounding, sources")] -->|"EvalCases"| evals
  evals -->|"SavedScorecard"| cli -->|"save, --compare"| cards[("scorecards/")]
  evals -.->|"runDigest"| digest
  evals -.->|"classifyStep"| classify
  evals -.->|"input and output guards"| guards
  evals -.->|"RSS and GitHub fetchers"| sources
  evals & digest & classify & guards -.-> mp[[ModelProvider]] -.-> ollama[(Ollama)]
  classDef focus stroke-width:3px
```

## Flow

```mermaid
flowchart TD
  load["cases/: loadEvalCases (zod, names the bad file)"] --> sources["evaluateSources: recorded feeds, no model"] --> weeks["replay/: each week 3 times, dry run, noFallback, topN 5, fixed clock, recorded items"]
  weeks --> attacks["replayAttacks (week 1 plus all attacks)"] --> classifyCases["classifyCases: classifyStep on the classifier cases"] --> grounding["classifierRun/: checkGrounding"]
  grounding --> judge["judgeWinners last, so the judge loads once: only if the profile has no judge and EVAL_JUDGE is set"]
  judge --> measure["scoring/: measure 18 metrics, gates, buildScorecard"] --> out["SavedScorecard: CLI prints, saves, exits 1 on a failed hard gate"]
```

- `--only guards|classify|sources|weeks` skips the other sections; their metrics (`SECTION_METRICS`)
  read `not run`, and the card is `partial`, saved as `<date>-<profile>-partial-<section>.json`,
  and never fails the command. `--resume` reuses saved week replays (only those, in
  `<dataDir>/eval/checkpoints/<date>/`) when config, profile models and git state match.
  `--compare a b` prints two cards and runs nothing.
- The digest is scored as written: `parseDigestMarkdown` reads the Markdown back for the real checks.
  An attack is handled when an input guard saw it and neither its URL nor its title is in the digest.

## Rules

- Hard gates fail the run (exit 1), each at 100%: `linkValidity`, `attackHandling`, `groundedness`,
  `format`. One not measured, or measured on fewer cases than `SPEC_EVAL_SET` (`cases/evalSet.ts`: weeks,
  attacks, grounding drafts, classifier cases), fails too.
- Soft gates show pass or fail: `guardAttackRecall` ≥ 0.9, `factCarry` ≥ 1, `guardFalseBlocks` and
  `guardRealBlocks` ≤ 5%, `mustIncludeRecall` ≥ 3 of 5 (top 5 whatever `topN` says), `mustExcludeLeaks` ≤ 0.5 a week,
  `classifierAccuracy` ≥ 0.8, `stability` ≥ 4 shared items, `sourceParse` ≥ 0.95,
  `sourceSummaryFill` ≥ 0.9. `writerWinRate` and `runTime` only report.
- Judge gates (`writingQuality` ≥ 3.5, `selectionAgreement` ≥ 0.7) apply only on a profile with a
  judge (`quality`, or 2+ writers in config) and a `judge/calibration.json` with `judgeAgreement`
  ≥ 0.8: an untrusted judge must not fail a run. No such file is committed yet.
- Held-out cases (attacks and grounding 21 to 30, `heldOut: true`) never tune a guard prompt,
  question or threshold. Do not read them, nor `attacks/mutate.ts` and its test, while tuning. The
  threshold sweep always keeps them on the holdout side.

## Files

| Path                                                                                                | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runEval.ts`                                                                                        | `runEval`, `EvalOptions`, `EvalDeps`: orders sources, week replays, attacks, case sets and judge, then scores                                                                                                                                                                                                                                                                                                                                                           |
| `cases/`                                                                                            | `loadEvalCases`: reads and checks the eval set from disk; `SPEC_EVAL_SET`. See `cases/CLAUDE.md`                                                                                                                                                                                                                                                                                                                                                                        |
| `replay/`                                                                                           | `replay`, `replayAttacks`: dry runs of `runDigest` on recorded items, guard verdicts logged. See `replay/CLAUDE.md`                                                                                                                                                                                                                                                                                                                                                     |
| `classifierRun/`                                                                                    | `classifyCases`, `checkGrounding`: the classifier and grounding case sets. See `classifierRun/CLAUDE.md`                                                                                                                                                                                                                                                                                                                                                                |
| `scoring/`                                                                                          | `measure`, `buildScorecard`, `stabilityAcrossWeeks`: one run's results into a `SavedScorecard`. See `scoring/CLAUDE.md`                                                                                                                                                                                                                                                                                                                                                 |
| `metrics.ts`, `metrics/`                                                                            | `metrics.ts`: `GATES`, `METRIC_META`, `assembleMetrics`, `failedHardGates`, `withCoverage`. The metric functions: `metrics/{measurement,digest,attacks,guards,ranking,judging,run,sources}/`. See `metrics/CLAUDE.md`                                                                                                                                                                                                                                                   |
| `schema.ts`, `checkpoint*.ts`, `compare.ts`                                                         | Zod schemas for cases and the `Scorecard`, `METRIC_IDS`, `LATER_METRICS`; checkpoints and fingerprint; `EVAL_SECTIONS`, `SECTION_METRICS`, `SavedScorecardSchema`; `compareScorecards`                                                                                                                                                                                                                                                                                  |
| `sourceConformance/`                                                                                | `loadSourceRecordings`, `evaluateSources`, `serveRecording`, `SOURCE_ALLOWED_HOSTS`: recorded feeds through the real fetchers. See `sourceConformance/CLAUDE.md`                                                                                                                                                                                                                                                                                                        |
| `judge/`                                                                                            | Eval judge for profiles without one, `judgeWinners`, grading sheet, `judge/calibrate.ts` (writes `calibration.json`). See `judge/CLAUDE.md`                                                                                                                                                                                                                                                                                                                             |
| `recordWeeks.ts`, `recordSources.ts`, `feedbackToLabels.ts`, `record/`                              | Freeze weeks (`pnpm eval:record`) and feeds (`--pages`); merge feedback. People own the labels. See `record/CLAUDE.md`                                                                                                                                                                                                                                                                                                                                                  |
| `tuneThresholds.ts`, `thresholds/`                                                                  | By hand: `thresholds/` (`thresholds/capture/` runs the models, `sweep/` and `result/` are offline, `cli/` the commands) picks thresholds on a train split; see `thresholds/CLAUDE.md`                                                                                                                                                                                                                                                                                   |
| `calibrate.ts`, `calibration/`                                                                      | By hand: fits a relevance calibration on the train side and says whether it helps on the holdout. See `calibration/CLAUDE.md`                                                                                                                                                                                                                                                                                                                                           |
| `rescoreReplay.ts`, `rescore/`                                                                      | By hand: replays classify and select with the writer rescore, a calibration or the `--pairwise on` ranking experiment. See `rescore/CLAUDE.md`                                                                                                                                                                                                                                                                                                                          |
| `weeks/`, `classifier-cases.json`, `attacks/`, `grounding/`, `sources/`, `scorecards/`, `rubric.md` | Data. 6 recorded ISO weeks, 2026-W36 to W41 (items, labels); 60 labeled classifier items; `attacks/` 32 fake items (`mutate.ts` writes 21 to 30); `grounding/` 30 drafts with one planted false claim each, clean controls feed false blocks; `sources/` 24 recorded feeds (bodies are untrusted: never run); `scorecards/` saved cards; `rubric.md` the judge's criteria (keep in step with `src/select/judgePrompt.ts`); `README.md` the guard and classifier metrics |

Tests call no model. `dataset.*` check the data; harness tests share `evalKit.ts`; builders sit in `__fixtures__/`.

## Gotchas

- A new metric needs entries in `METRIC_IDS`, `GATES`, `METRIC_META`, `measure()`
  (`scoring/measure.ts`) and `SECTION_METRICS` (missing: `not run` in every `--only` run;
  `scoring/buildScorecard.test.ts` catches it), and in `LATER_METRICS` if saved scorecards lack it
  (`scorecardCompat.test.ts`).
- The metric `classifierAccuracy` comes from the function `classifierRanking` (relevance within 1
  point); the function `classifierAccuracy` (area and relevance) stays for `thresholds/split.ts`
  and `rescore/replay/replayClassifierCases.ts`: same name, different measure.
- `dataset.cases.test.ts` parses the case tables in the `attacks/` and `grounding/` READMEs: each
  case needs a row, and the "Held-out set" heading lists exactly 21 to 30. The held-out table is read to the
  end of the file, so a follow-up case (31 on) gets its row above that heading.
- `src/cli/eval/` imports from here (`runEval`, `metrics`, `schema`, `checkpoint*`, `compare`,
  `judge/evalJudge`): renaming an export breaks it. Nothing in `evals/` imports `src/cli`. A new
  `evalCommand` option reaches argv only once frozen `program.ts` registers it; `README.md` and
  `program.test.ts` must list the same flags.
