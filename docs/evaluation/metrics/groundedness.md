# Groundedness

Part of [Metrics](README.md).

## What it measures

The share of drafts with one planted false claim that the output guards rejected.

## Why it matters

A writer can state a version, a number or a date that its source never gave. A reader cannot tell.
The output guards are the defence, so the eval plants known errors and checks that they are found.

## How it is computed

`groundedness` in `evals/metrics/guards/groundedness.ts`, fed by `checkGrounding` in
`evals/classifierRun/checkGrounding.ts`.

1. For each of the 30 grounding cases (the saved scorecard has 10), the draft with the planted claim and its clean control (the draft
   without the planted item) go through `guardOutputStep` together. All output checks are on,
   mode `any`, with the case's source items.
2. The case is **caught** when the planted draft is among the rejected drafts.
3. The value is cases caught divided by cases. `detail` counts how many planted drafts each output
   guard flagged.

If an output check was switched off, the value is not measured and the note says
`guards were off: ...`. The clean controls are counted by
[guard false blocks](guard-false-blocks.md), not here.

## The gate

- Hard, at least 1 (100%). No judge rule.
- A miss means a false claim passed the guards. The run exits with 1.
- Not measured fails too, and so does a set of fewer than 10 grounding cases.
  See [gates](../gates.md).

## Data it uses

The [grounding cases](../sets/grounding.md): 30 drafts. Cases 01 to 10 are the original set, 11 to 20
plant subtler claims (a version one minor higher, a date a week off) and 21 to 30 are held out. The
gate stays at 100%, so the harder cases make it harder to pass.

## How to add a case

Write a draft with one planted false claim and its sources, add the row to the README and the
pattern to the test. Never tune a guard question on cases 21 to 30. See [grounding cases](../sets/grounding.md#how-to-extend-it) and
[adding cases](../adding-cases.md).

## Current result

Current result: 100%, pass (scorecard 2026-10-18, profile light). See [results](../results.md#groundedness).
