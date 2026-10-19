# Classifier accuracy

Part of [Metrics](README.md).

## What it measures

The share of labeled items for which the classifier gives the right focus area and a relevance
close to the label.

## Why it matters

The classifier decides what reaches the writers. A wrong area or a wrong relevance means a good
release is dropped or a hype post is promoted before any writer starts. This is the check on that
one step, alone.

## How it is computed

`classifierAccuracy` in `evals/metrics.ts`, fed by `classifyCases` in `evals/runEval.ts`.

1. All 60 items go through `classifyStep` with the focus areas and area hints of the loaded config.
2. A case is right when **both** hold:
   - the area matches the label, ignoring case and surrounding spaces;
   - the relevance is within 0.5 of the label (the labels are whole numbers 0 to 3).
3. The value is right cases divided by cases. `detail` has the area-only rate and the
   relevance-only rate.

If `classifier-cases.json` has `reviewed: false` the note says the labels are not reviewed yet.

## The gate

- Soft, at least 0.8 (80%). No judge rule.
- A miss shows `FAIL` and does not change the exit code. The classifier is not reliable enough on
  this profile.
- With fewer than 60 cases the note says so; the verdict stays. See [gates](../gates.md).

The threshold sweep reports a looser "filter accuracy" (keep an item when its label is 2 or 3).
That is a different number. This metric needs the exact area and relevance.

## Data it uses

The [classifier cases](../sets/classifier-cases.md). They use the default focus areas, so run the
eval with those; other areas will not match.

## How to add a case

Add an entry to `evals/classifier-cases.json` and keep the balance rules. See
[classifier cases](../sets/classifier-cases.md#how-to-extend-it) and [adding cases](../adding-cases.md).

## Current result

Current result: 28.3% (area 68%, relevance 42%), fail (scorecard 2026-10-18, profile light). See [results](../results.md#classifier-accuracy).
