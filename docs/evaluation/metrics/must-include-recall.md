# Must-include recall

Part of [Metrics](README.md).

## What it measures

How many of the maintainer's five must-include items for a week appear in that week's digest, on
average over the weeks. The best possible value is 5.

## Why it matters

This is the closest thing to "did the digest pick the releases that matter". Each week the
maintainer names five items a good digest must hold. Missing them means the classifier, the
ranking or the writers dropped something important.

## How it is computed

`mustIncludeRecall` in `evals/metrics.ts`, through `hitsPerWeek`.

1. For each week, take the `mustInclude` ids from `labels.json` that the replay served.
2. Count how many of them are among the items the digest links to (`digestItemIds`).
3. The value is the mean of those counts over the weeks. A week with no digest finds 0.

The replay uses `topN` 5 whatever your config says. A label the replay did not serve is **not
visible**: the production cap per source cut it off. It is not counted as found, and it lowers that
week's best possible count. The number goes to `detail.notVisible` and the note says so.

## The gate

- Soft, at least 3 (of 5). No judge rule.
- A miss shows `FAIL` and does not change the exit code. The digest is missing too many of the
  items the maintainer wanted.
- With fewer than 6 weeks the note says so; the verdict stays. See [gates](../gates.md).

## Data it uses

The [recorded weeks](../sets/recorded-weeks.md): `items.json` and `labels.json`.

## How to add a case

Label another week by hand, or turn feedback on a real week into labels with
`digest feedback <week>` and `evals/feedbackToLabels.ts`. A week needs exactly 5 must-include ids.
See [recorded weeks](../sets/recorded-weeks.md#labeling-and-extending) and
[add an eval case from a bad week](../../runbooks/maintain/add-eval-case-from-a-bad-week.md).

## Current result

Current result: 1.33 of 5, fail (scorecard 2026-10-18, profile light). See [results](../results.md#must-include-recall).
