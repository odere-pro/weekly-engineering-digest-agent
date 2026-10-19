# How evals work

Part of [Evaluation](README.md).

`digest eval` replays frozen test data through the real pipeline and models, scores the result and
saves a scorecard. It needs no network for feeds and sends nothing. It does call Ollama, so it is
slow. Maintainer notes: [evals/CLAUDE.md](../../evals/CLAUDE.md) and
[evals/README.md](../../evals/README.md). Feature page: [evals](../features/evals.md).

## The run, end to end

```text
evals/ data: weeks, classifier cases, attacks, grounding drafts, source recordings
   |
   v
load and check every file (a bad file stops the run, exit 1)
   |
   +-> source recordings ---> real RSS and GitHub fetchers, no model ---> source metrics
   |
   +-> recorded weeks ------> runDigest, dry run, 3 times per week ----> digests, run records
   |      '-> first week again, with all attack items mixed in --------> attack results
   |             '-> each input guard asked about each attack alone ----> independent recall
   |
   +-> classifier cases ----> classify step ---------------------------> classifier results
   +-> grounding drafts ----> output guards (draft and clean control) --> grounding results
   '-> optional: a judge model scores each week's winning digest (EVAL_JUDGE)
   |
   v
evals/scoring/: 17 measurements -> gates (evals/metrics.ts) -> scorecard
   |
   +-> printed on the terminal, saved to evals/scorecards/<date>-<profile>.json
   '-> exit code 1 when a hard gate failed
```

## Steps

1. **Load.** `loadEvalCases` (`evals/cases/`) reads every file under `evals/` and checks it with the
   schemas in `evals/schema.ts`. An unreadable or invalid file stops the run and the message names the file.
   A missing case folder counts as an empty set, and a hard gate cannot pass on an empty set.
2. **Source recordings.** The real fetchers run over the recorded feed bodies. No model is used.
   See [source recordings](sets/source-recordings.md).
3. **Replay the recorded weeks.** Each week is a dry run of `runDigest`. Real models and guards
   run. These parts are fake: the fetchers serve the recorded items (newest first, capped per
   source as in production), the store is in memory, the clock stands at the end of the week and
   there are no deliveries. Every guard is on in mode `any` (the rule guard `ruleInjection`, `clefPolicy`
   and `graniteRisk` on input; `graniteGroundedness` and `clefRubric` on output) and `topN` is 5. Focus areas, thresholds
   and models come from your config and profile. The template fallback digest is off (`noFallback`),
   so a week where every draft is rejected stays `blocked` and shows up as a week with no digest.
4. **Repeat for stability.** Every week runs three times in total. The gate uses the first week's
   overlap. The 18 replays also feed [guard blocks on real weeks](metrics/guard-real-blocks.md).
   See [stability](sets/stability.md).
5. **Attacks.** The first week runs once more with all 30 attack items added, dated just before
   the end of the week. Then every enabled input guard is asked about every attack item on its
   own, whatever the guard mode, so a guard that comes later is not scored on what is left over
   (independent recall). This is record only: the run itself is unchanged. It costs about (guards
   minus 1) times the number of attacks in extra calls. See [attacks](sets/attacks.md).
6. **Classifier cases.** All labeled items go through the classify step in one call. See
   [classifier cases](sets/classifier-cases.md).
7. **Grounding.** Each of the 30 drafts with a planted false claim goes through the output guards
   with its clean control (the same draft without that item). See [grounding](sets/grounding.md).
8. **Judge (optional).** If the profile has no judge and `EVAL_JUDGE` names a model, that model
   scores each week's winning digest. It runs last so the judge model loads once. A model that is
   not installed, or has no decision capability, stops the run before anything is replayed.
   See [judge](sets/judge.md).
9. **Score.** `evals/scoring/measure.ts` turns the results into 17 measurements (the metric functions are in
   `evals/metrics/`) and `evals/metrics.ts` adds the gates. The
   digest is read back from the Markdown that was written, so the real link check and format
   check judge what a reader would get. The classifier is scored on ranking: see
   [classifier accuracy](metrics/classifier-accuracy.md).
10. **Save.** The CLI checks the scorecard, prints it and saves
    `evals/scorecards/<date>-<profile>.json` (UTC date). A second run on the same day overwrites
    the file, so copy the first one under another name if you want to keep it.

## Running it

```bash
pnpm digest eval --profile light
```

Without `--profile` it uses the configured profile. `--profile all` runs `quality`, `fast` and
`light` one after another. Run it from the repository root: the data folder is `evals/` in the
working directory. Set `EVAL_JUDGE=clef:latest` in `.env` or the shell to score writing quality on
`light` and `fast`. Steps and checks: [run the evals](../runbooks/run/run-evals.md).

To run one section, finish a lost run or compare two scorecards, see
[running parts of the eval](running-sections.md). Every week replay is saved as a checkpoint.

## Cost and time

- No money: everything runs on local Ollama models. The cost is machine time.
- A run replays 19 pipeline runs (6 weeks three times, plus the attack replay), then asks the input
  guards about the attacks and the output guards about the grounding drafts. On `light` the saved
  run took 112.5 minutes on an M1 Pro with 32 GB; one replay takes about 340 s on average.
- That scorecard (2026-10-18) used 20 attacks and 10 grounding drafts. The next one uses 30 and 30,
  so its guard part will take longer. No new time has been measured.
- Only one model is loaded at a time, so run one profile at a time and leave the machine alone.
- `fast` and `quality` have never been measured. `quality` did not run in reasonable time on the
  reference laptop. See [results](results.md).

## Reading the output

The terminal shows a header, a table (metric, value, gate, result) and the final line
`Hard gates: PASS` or `Hard gates: FAIL (...)`. Under it come details per guard, the weeks that
did not pass (a week with no digest names the cause: `blocked by <guard>`, `rejected by <check>`
or `run ended as "<status>"`), the item ids of each stability run and notes. A partial run adds a
`Partial run:` line. The JSON file has everything in full.
