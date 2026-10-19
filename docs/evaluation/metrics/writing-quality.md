# Writing quality

Part of [Metrics](README.md).

## What it measures

The mean judge score, from 1 to 5, of the winning digest of each recorded week.

## Why it matters

The other metrics say whether the digest is safe and well formed. This one asks whether it is
good: accurate against its sources, clear, useful and on topic.

## How it is computed

`writingQuality` in `evals/metrics/judging/judgeMetrics.ts` is the mean of a list of scores. Where the scores come from
depends on the profile.

- **A profile with a judge** (`quality`): the score the select step gave the winning draft of each
  replayed week.
- **A profile without one** (`fast`, `light`): when `EVAL_JUDGE` names a model, `judgeWinners`
  scores the winning digest of each week after all replays. `judgedQuality` adds a note that names
  the judge and any week it could not score.

The score is the mean of four criteria, each 1 to 5: accuracy, clarity, why it matters and focus fit
([judge](../sets/judge.md)). A week with no digest or no winner has no score and is skipped. With
no score at all the value is not measured.

## The gate

- Soft, at least 3.5, and it needs a trusted judge.
- Gated only when the calibration shows the judge agrees with the maintainer at least 80% of the
  time, and the profile has its own judge. Otherwise the value is reported with the note
  `judge not calibrated: reported, not gated`. See [gates](../gates.md#the-judge-agreement-rule).
- A miss, when it is gated, shows `FAIL` and does not change the exit code.

## Data it uses

The winners of the [recorded weeks](../sets/recorded-weeks.md), scored by the [judge](../sets/judge.md).

## How to add a case

Not applicable as a case file: the metric scores whatever the replay wrote. More weeks give more
scores. To make the number count, calibrate the judge with a hand-graded sheet
([judge](../sets/judge.md#calibrating-the-judge)).

## Current result

Current result: 3.62 of 5, not gated, judge not calibrated (scorecard 2026-10-18, profile light, scored by `clef:latest`). See [results](../results.md#writing-quality).
