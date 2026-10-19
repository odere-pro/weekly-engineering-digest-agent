# Run time

Part of [Metrics](README.md).

## What it measures

The mean wall-clock time of one week's replay, in milliseconds in the file and in seconds on the
terminal. The total is in `detail.totalMs`.

## Why it matters

It tells you how long a weekly run takes on this machine with this profile. You need it to choose a
schedule slot, to compare profiles and to notice that a new model or setting made the run slower.

## How it is computed

`runTime` in `evals/metrics.ts`. The eval times each plain replay of a recorded week with the system
clock, around the dry run of `runDigest`. The value is the mean of those times. `detail.totalMs` is
their sum.

It does not include the repeats for stability, the attack replay, the classifier cases, the
grounding cases, the source recordings or the judge. The whole eval takes longer. The scorecard's
`timings` section has the eval's total time and the time of each week.

## The gate

- None. The value is reported only. There is no pass or fail.

## Data it uses

The [recorded weeks](../sets/recorded-weeks.md). A week with more items takes longer: on the newest
scorecard 2026-W36 (31 items) took 208 s and 2026-W41 (104 items) took 582 s.

## How to add a case

Not applicable. It is a timing, not a check.

## Current result

Current result: 340 s mean per week, not gated (scorecard 2026-10-18, profile light; 208 s to 582 s). See [results](../results.md#run-time).
