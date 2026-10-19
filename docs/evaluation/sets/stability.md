# Stability runs

Part of [Eval sets](README.md).

Stability is not a separate data file. It reuses the [recorded weeks](recorded-weeks.md) and runs
the same week more than once. This page explains why and how the number is made.

## Why it exists

The same input should give nearly the same digest. If a week picks five different items every
time you run it, a reader cannot trust any one digest. The models run seeded and at a fixed
temperature, so the picks should repeat. The stability runs prove it, or show where it breaks.

## What runs

- `STABILITY_RUNS` in `evals/runEval.ts` is 3. Each recorded week is replayed three times in total:
  the plain replay that feeds all other metrics, plus two repeats.
- The repeats are dry runs with the same items, the same fixed clock, every guard on and `topN` 5.
- For each run the eval keeps the ids of the collected items the digest links to. A run that
  produced no digest (blocked, quiet or failed) keeps an empty list.
- Scorecards from 2026-10-17 repeated only the first week. The newest one repeats every week,
  which is why a `light` run now takes about 110 minutes.

## How the overlap is computed

`stability` in `evals/metrics.ts` compares every pair of runs. For runs a, b and c it looks at
(a, b), (a, c) and (b, c). For each pair it counts the distinct item ids found in both. The value is
the mean of those counts. The most it can be is 5, when all runs picked the same five items.

| Runs                              | Pair overlaps | Value |
| --------------------------------- | ------------- | ----- |
| Same 5 items three times          | 5, 5, 5       | 5.00  |
| Same 5 items twice, one empty run | 5, 0, 0       | 1.67  |
| Pairs share 4, 3 and 3 items      | 4, 3, 3       | 3.33  |

## What the scorecard shows

- `value`, `note` and `itemIdsByRun` are those of the **first** recorded week. The gate has always
  meant this week, so old and new scorecards compare. The note reads
  `overlap of 3 runs of 2026-W36`.
- `detail.runs` is the number of runs and `detail.emptyRuns` is how many had no items. A low
  value with empty runs means a blocked digest, not different picks. Read `itemIdsByRun` to tell.
- `byWeek` has one line per week: `overlap 5.00 items over 3 runs, 0 empty`. A week with an empty
  run has status `no-digest`.
- The terminal prints the first eight characters of each run's ids under "Item ids by run".

## The gate

Soft, at least 4 shared items. See [stability](../metrics/stability.md) and [gates](../gates.md).

## How to refresh or extend it

Nothing to record. It follows the recorded weeks. To change the number of runs, a maintainer
changes `STABILITY_RUNS`, which changes the run time in proportion.

## Rules

- Stability needs deterministic settings: keep `models.seed` and the temperatures as configured
  when you compare two scorecards. See [set seed and temperature](../../runbooks/configure/set-seed-and-temperature.md).
- Compare only scorecards made with the same weeks and the same profile.
