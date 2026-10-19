# Must-exclude leaks

Part of [Metrics](README.md).

## What it measures

How many of the maintainer's must-exclude items appear in a week's digest, on average over the
weeks. The best possible value is 0.

## Why it matters

A digest that is full of hype posts and minor version bumps wastes the reader's time. Each week the
maintainer marks the items that must stay out. This metric counts the ones that got in anyway.

## How it is computed

`mustExcludeLeaks` in `evals/metrics/ranking/labelHits.ts`, through the same `hitsPerWeek` as
[must-include recall](must-include-recall.md).

1. For each week, take the `mustExclude` ids that the replay served.
2. Count how many of them are among the items the digest links to.
3. The value is the mean of those counts over the weeks.

A label the replay did not serve is **not visible**: it can be neither found nor leak. It is
counted in `detail.notVisible` and the note says so. A week with no digest has no leaks.

## The gate

- Soft, at most 0.5 leaks per week. No judge rule.
- A miss shows `FAIL` and does not change the exit code. More than one week in two lets a
  must-exclude item into the digest.
- With fewer than 6 weeks the note says so; the verdict stays. See [gates](../gates.md).

## Data it uses

The [recorded weeks](../sets/recorded-weeks.md): `mustExclude` in `labels.json`.

## How to add a case

Add ids to `mustExclude` of a week, or label a new week. An id cannot be in both lists. Wrong
picks you tick in `review.md` become must-exclude through `digest feedback <week>` and
`evals/feedbackToLabels.ts`. See [recorded weeks](../sets/recorded-weeks.md#labeling-and-extending).

## Current result

Current result: 0.67 per week, fail (scorecard 2026-10-18, profile light). See [results](../results.md#must-exclude-leaks).
