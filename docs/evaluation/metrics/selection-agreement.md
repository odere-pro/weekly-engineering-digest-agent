# Selection agreement

Part of [Metrics](README.md).

## What it measures

How often the judge picks the same draft as the maintainer, when two writers wrote the same week.

## Why it matters

With two writers, the select step sends the draft the judge likes best. If the judge disagrees
with the maintainer, the better digest is often not the one that is sent.

## How it is computed

It is not measured on every eval run. The scorecard copies `selectionAgreement` from
`evals/judge/calibration.json` and adds the note `from judge/calibration.json`. Without a
calibration file, or on a profile without a judge, the value is not measured.

`selectionAgreement` in `evals/metrics.ts` makes the number, and `evals/judge/calibrate.ts` calls it
on the hand-graded sheet.

1. For each week where the maintainer compared two drafts, the **human pick** is the writer named
   in `picks`.
2. The **judge pick** is the writer whose draft the judge scored highest that week. If two drafts
   tie, the judge shows no preference and the week counts as a disagreement.
3. The value is weeks where the picks match divided by weeks with a pick.

## The gate

- Soft, at least 0.7, and it needs a trusted judge.
- Gated only when the judge agrees with the maintainer at least 80% of the time on the hand-graded
  digests and the profile has its own judge. Otherwise it is reported, not gated. No calibration
  file is committed yet, so today it shows "not measured". See [gates](../gates.md#the-judge-agreement-rule).

## Data it uses

The grading sheet in `evals/judge/` and the digests of two writers. See [judge](../sets/judge.md).

## How to add a case

Add digests of two writers for a week to the grading sheet, grade them by hand, add a `picks`
entry, and run `pnpm exec tsx evals/judge/calibrate.ts`. Steps:
[calibrating the judge](../sets/judge.md#calibrating-the-judge).

## Current result

Current result: not measured, not gated (scorecard 2026-10-18, profile light; no calibration file). See [results](../results.md#selection-agreement).
