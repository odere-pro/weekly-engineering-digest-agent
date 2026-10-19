# Classifier accuracy

Part of [Metrics](README.md).

## What it measures

The share of labeled items for which the classifier gives a relevance within one point of the label
(on the 0 to 3 scale). The area and a rank correlation are reported next to it.

## Why it matters

The classifier decides what reaches the writers. A relevance far from the label means a good
release is dropped or a hype post is promoted before any writer starts. What matters for the top 5
is that items come out in about the right order and place. The old measure (exact area and a
relevance within half a point) punished small slips that change nothing. This is the check on that
one step, alone.

## How it is computed

`classifierRanking` in `evals/metrics.ts` (wave 11, ranking accuracy), fed by `classifyCases` in
`evals/runEval.ts`.

1. All 60 items go through `classifyStep` with the focus areas and area hints of the loaded config.
2. A case is right when its relevance is within 1 of the label (the labels are whole numbers 0 to 3).
   The value, and the gate, is right cases divided by cases.
3. `detail` also has `area`, the share with the right area (ignoring case and surrounding spaces);
   `relevanceWithinOne`, the same as the value; and `spearman`, the rank correlation of predicted
   and labeled relevance. Ties get the mean of their ranks. `spearman` is left out when it is
   undefined (fewer than two cases, or all values equal).
4. The area no longer decides the gate.

The old function `classifierAccuracy` (area and relevance within 0.5 both right) stays in
`metrics.ts` for the threshold sweep and the rescore replay. The scorecard does not use it.
Scorecards written before wave 11 keep their old `detail` keys (`area`, `relevance`) and still parse.

If `classifier-cases.json` has `reviewed: false` the note says the labels are not reviewed yet.

## The gate

- Soft, at least 0.8 (80%). No judge rule.
- A miss shows `FAIL` and does not change the exit code. The classifier is not reliable enough on
  this profile.
- With fewer than 60 cases the note says so; the verdict stays. See [gates](../gates.md).

The threshold sweep reports a third number, "filter accuracy" (keep an item when its label is 2 or
3). It is a different number again. Wave 11 also fits a relevance calibration offline; see
[classifier cases](../sets/classifier-cases.md#calibrating-the-relevance).

## Data it uses

The [classifier cases](../sets/classifier-cases.md). They use the default focus areas, so run the
eval with those; other areas will not match.

## How to add a case

Add an entry to `evals/classifier-cases.json` and keep the balance rules. See
[classifier cases](../sets/classifier-cases.md#how-to-extend-it) and [adding cases](../adding-cases.md).

## Current result

Current result: 28.3% (area 68%, relevance 42%), fail (scorecard 2026-10-18, profile light; measured the old way, exact area and relevance within 0.5. The next scorecard uses the within-one rule). See [results](../results.md#classifier-accuracy).
