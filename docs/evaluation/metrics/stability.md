# Stability

Part of [Metrics](README.md).

## What it measures

How many items the same week's digests have in common when the week is run several times. The best
possible value is 5.

## Why it matters

The pipeline is meant to be repeatable: same feeds, same settings, same digest. If a rerun picks
different items, nobody can trust any single run, and a "fix" cannot be told from noise.

## How it is computed

`stability` in `evals/metrics.ts`. Every recorded week runs three times. For the first week, the
eval keeps the ids of the items each run linked to.

1. Every pair of runs is compared: (1, 2), (1, 3), (2, 3).
2. The overlap of a pair is the number of distinct item ids in both runs.
3. The value is the mean overlap. `detail` holds the number of runs and how many were empty.
   `itemIdsByRun` holds the ids of each run. The note names the week.

A run with no digest has no ids. One empty run next to two identical runs gives (5 + 0 + 0) / 3 =
1.67, so an empty run pulls the value down hard. Read `emptyRuns` and `itemIdsByRun` to tell a
blocked run from different picks. The value is the first week's. `byWeek` adds each week's own
overlap. Full explanation: [stability runs](../sets/stability.md).

## The gate

- Soft, at least 4 shared items. No judge rule.
- A miss shows `FAIL` and does not change the exit code. Runs of the same week pick different items,
  or some of them produce nothing. See [gates](../gates.md).

## Data it uses

The [recorded weeks](../sets/recorded-weeks.md), replayed three times each
([stability runs](../sets/stability.md)).

## How to add a case

Not applicable. It follows the recorded weeks, and the number of runs is a constant in
`evals/runEval.ts`. Repeatability depends on the seed and temperature in your config. See
[set seed and temperature](../../runbooks/configure/set-seed-and-temperature.md).

## Current result

Current result: 1.67 of 5, fail (scorecard 2026-10-18, profile light; 5.00 on four weeks, one blocked run on W36 and W39). See [results](../results.md#stability).
