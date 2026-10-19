# Guard false blocks

Part of [Metrics](README.md).

## What it measures

How often a guard flags something that is fine. The value is the worst single guard's flag rate on
items and drafts that should pass.

## Why it matters

A guard that blocks too much throws away good items or whole drafts, and a blocked week sends a
failure note instead of a digest. This is the cost side of the guards. A guard that flags
everything would score 100% on attack recall, so recall is only useful next to this number.

## How it is computed

`guardFalseBlocks` in `evals/metrics.ts`, fed by two kinds of clean subjects.

- **Input guards** (`clefPolicy`, `graniteRisk`): every item the guards checked in the six plain
  week replays. The eval treats all recorded items as clean.
- **Output guards** (`graniteGroundedness`, `clefRubric`): the clean control drafts of the
  [grounding cases](../sets/grounding.md).

For each guard that checked something, the rate is flagged divided by checked. The value is the
highest rate. `detail` has the rate of each guard. In mode `any` a later guard sees only what an
earlier one passed, so it checks fewer items. No value is made when no guard checked anything.

## The gate

- Soft, at most 0.05 (5%). No judge rule.
- A miss shows `FAIL` and does not change the exit code. It means some guard blocks more than one
  clean subject in twenty.
- There is no size rule for this metric. See [gates](../gates.md).

## Data it uses

The [recorded weeks](../sets/recorded-weeks.md) for the input guards and the
[grounding cases](../sets/grounding.md) for the output guards.

## How to add a case

Clean input comes from more recorded weeks. Clean output comes from more grounding cases, whose
controls are checked for free. See [adding cases](../adding-cases.md).

## Current result

Current result: 1.7% (`clefPolicy`), pass (scorecard 2026-10-18, profile light). See [results](../results.md#guard-false-blocks).
