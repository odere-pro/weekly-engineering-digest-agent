# Writer win rate

Part of [Metrics](README.md).

## What it measures

How often each writer model wrote the digest that won the week. The value is the share of the
leading writer.

## Why it matters

It shows whether a second writer earns its cost. A writer that never wins is time spent for
nothing. A writer that always wins may make the panel pointless. On a one-writer profile the
answer is always 100% and says nothing.

## How it is computed

`writerWinRate` in `evals/metrics.ts`. It takes the `winner` of each replayed week's run record,
skips weeks without a winner, and counts wins per writer. `detail` has the share of each writer. The
value is the largest share. With no winners the value is not measured.

## The gate

- None. The value is reported only. There is no pass or fail.

## Data it uses

The winners of the [recorded weeks](../sets/recorded-weeks.md).

## How to add a case

Not applicable. It follows the recorded weeks and the writers in the profile. See
[change models or writers](../../runbooks/configure/change-models-or-writers.md).

## Current result

Current result: 100% for `gemma4:e4b-mlx`, not gated, the only writer (scorecard 2026-10-18, profile light). See [results](../results.md#writer-win-rate).
