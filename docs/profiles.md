# Profiles: measured speed and quality

This page holds the numbers the README profile table points to. They come from
`pnpm digest eval --profile <name>` on the reference hardware. Nothing here is guessed.

## Reference hardware

- Apple M1 Pro, 32 GB RAM, macOS, Ollama on the host, `OLLAMA_MAX_LOADED_MODELS=1`.
- Guard thinking off (the default since W2-07). Every guard on, mode `any`.
- Thresholds from the light-profile sweep (W3-03): `minRelevance` 1.5, `maxHype` 0.6,
  `maxMinorRelease` 0.75, `guardFlag` 0.35.

## Results

| Profile   | Measured            | Run time per week                    | Hard gates                                                                    | Soft gates                                                                                                                                                              | Writer win rate                         |
| --------- | ------------------- | ------------------------------------ | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `light`   | 2026-10-17 (wave 5) | 320 s mean, 219 s to 516 s           | 2 of 4 pass: links 100%, grounded 100%; attacks 90% (fail), format 83% (fail) | false blocks 50% (fail); guard attack recall 60% (gate 90%); must-include recall 1.17 (gate 3); must-exclude leaks 0.50 (pass); classifier 27%; stability 1.33 (gate 4) | `gemma4:e4b-mlx` 100% (the only writer) |
| `fast`    | no                  | not measured on the reference laptop | not measured                                                                  | not measured                                                                                                                                                            | not measured                            |
| `quality` | no                  | not measured on the reference laptop | not measured                                                                  | not measured                                                                                                                                                            | not measured                            |

The `light` row is the wave 5 scorecard `evals/scorecards/2026-10-17-light-wave5.json` (main at
27e5db0 plus the W5-08 eval changes, every guard on, no eval judge): 6 recorded weeks, 60 classifier
cases, 10 attacks, 10 grounding cases, 45 minutes. The v0.1.0 baseline
`evals/scorecards/2026-10-17-light.json` stays for comparison. Both were written on the same day, so
the newer file carries a `-wave5` suffix. The eval sets are the same; the code is wave 5's.

| Metric              | v0.1.0 baseline | Wave 5       | What moved                                                                                |
| ------------------- | --------------- | ------------ | ----------------------------------------------------------------------------------------- |
| Format              | 67% (4 of 6)    | 83% (5 of 6) | One more week passes. 2026-W39 still has no digest (see below).                           |
| Link validity       | 100%            | 100%         | Same.                                                                                     |
| Attack handling     | 100%            | 90%          | One attack item no guard flagged reached the attack replay's digest (hard gate, red).     |
| Guard attack recall | not recorded    | 60%          | `clefPolicy` flagged 6 of 10, `graniteRisk` added none.                                   |
| Guard false blocks  | 0%              | 50%          | Probably the headline and intro check added to the groundedness guard (W5-02).            |
| Must-include recall | 1.00            | 1.17         | Gate 3. Still far under it.                                                               |
| Must-exclude leaks  | 0.67            | 0.50         | One label (2026-W39) is outside the replay window and counts as neither found nor leaked. |
| Stability           | 0               | 1.33         | Runs 1 and 3 share 4 of 5 items; run 2 produced no digest.                                |
| Run time per week   | 317 s           | 320 s        | Mean over the 6 weeks.                                                                    |

## How to read the light row

- **Run time** is one replayed week: collect from the recording, guards, classify, write, check.
  The slowest weeks (2026-W40, 2026-W41) had the most items.
- **Format 83%** means 5 of 6 weeks produced a digest that passed the format check (3 to 5 items,
  under 500 words, no em dash, every section present). A week with no surviving draft counts as a
  failure. 2026-W39 is the one: the writer put a link without a scheme (`www.docker.com/blog/...`)
  in both attempts, so the link check rejected the draft twice and the retry (W5-06) did not help.
  `byWeek` lists it as `no-digest`. This is still an open hard gate.
- **Classifier 27%** is the exact match of area and relevance on the 60 labeled cases. The filter
  decision alone (keep or drop) is right 87% of the time at the tuned thresholds. The 2B light
  classifier gives nearly every item a relevance between 1.0 and 1.9, so it barely separates items.
- **Must-include recall 1.17 and leaks 0.50** are per-week averages against the hand labels: about
  1.2 labeled must-include items per week make the digest (the gate asks for 3), and half of a
  must-exclude item leaks in (the gate allows 0.5).
- **Stability 1.33** is the mean number of items two reruns of one week have in common, over three
  runs of the first recorded week (2026-W36). It is not a count of weeks and it does not rise as
  weeks pass. The gate asks for 4 in common. The scorecard keeps the item ids of every run
  (`itemIdsByRun`) and counts the empty runs (`detail.emptyRuns`): runs 1 and 3 share 4 of their 5
  items, but run 2 was blocked and has none, so two of the three pairs score 0. The v0.1.0 baseline
  kept no ids, so its 0 cannot be explained the same way.
- **Writing quality and selection agreement** need a judge model. The light profile has none, so
  they are not measured. The harness can score each week's winning digest with an eval judge
  (`EvalDeps.judge`) when the profile has none. `digest eval` passes one when `EVAL_JUDGE` names a
  model in the shell environment (for example `EVAL_JUDGE=clef:latest`); a value in `.env` is not
  read. Such scores are reported, not gated: a judge calibration applies only to a profile that has
  a judge.

## What a scorecard shows beyond the table

- **Replay window.** The v0.1.0 baseline replayed up to 100 items per source. A replay now serves
  each source as production does: its own `maxItems`, else `maxItemsPerSource` (20 by default).
  A labeled item outside that window is "not visible": it can be neither found nor leak, and
  `detail.notVisible` counts it. A must-include label there lowers that week's best possible
  recall, so move the label. Under the default allowlist one recorded label is affected, the
  2026-W39 must-exclude `d2871d486c61275a` (item 22 of `openai-news`). The wave 5 scorecard
  shows it as `detail.notVisible` 1 on the must-exclude leaks.
- **Per-week detail.** `byWeek` on the format and link metrics gives each replayed week a status
  (`ok`, `failed`, `no-digest`) and its first five problems. The attack replay has its own line.
- **Guard attack recall.** The share of attack cases the input guards flagged on their own, with
  each guard's count in `detail`. In mode `any` a later guard sees only what an earlier one let
  through. It is a soft gate at 90%. Attack handling can pass while this is low, because an attack
  the guards miss may simply not be selected.

## Why fast and quality are not measured

The quality profile writes with two 30B-class models and judges with `clef:latest`. One week took
hours on the reference laptop under load (see the W2-05 notes in the run history). The fast profile
shares the 30B writer. Both wait for a machine with more memory bandwidth. Until then the README
marks them "not measured" and the light profile is the default for evals.

## How to measure again

```bash
pnpm digest eval --profile light
```

The scorecard lands in `evals/scorecards/<date>-<profile>.json`. Commit it with the release and
update the table above. Run one profile at a time; the evals load one model after another. A second
run on the same day overwrites that file, so copy the first one under another name before you start
(`evals/scorecardCompat.test.ts` reads `2026-10-17-light.json`). A run takes about 45
minutes on the light profile.

## Calibrating the judge

The judge's scores are gated only when it agrees with the maintainer at least 80% of the time.
`evals/judge/grades.template.json` is the sheet for the 10 hand-graded digests: copy it to
`evals/judge/grades.json` and fill in the weeks, writers, grades and picks (its `instructions` field
says how). After the judge has scored the same digests, `pnpm exec tsx evals/judge/calibrate.ts`
reports judge agreement, selection agreement, the Spearman rank correlation and the mean absolute
difference, and writes `evals/judge/calibration.json`. It calls no model. It wants all 10 digests
(`--min-digests N` accepts fewer), and a tie in the judge's scores counts as a disagreement.
