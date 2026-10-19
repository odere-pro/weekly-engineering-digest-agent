# Source parse yield

Part of [Metrics](README.md).

## What it measures

The share of expected feed items that the fetchers actually parse from the recorded responses,
pooled over all sources.

## Why it matters

Everything downstream starts with the fetchers. If a feed changes its format and a parser silently
drops entries, the digest loses items and nobody sees an error. This metric catches that without
any network or model.

## How it is computed

`sourceParse` in `evals/metrics/sources/sourceMetrics.ts`, on the results of `evaluateSources` in
`evals/sourceConformance/conformance/evaluateSources.ts`.

1. The real fetcher of each source's kind (RSS or GitHub) runs over the source's recording.
2. Per source: items parsed divided by items expected (`expected.json`), at most 1.
3. The value is the total parsed over the total expected. Sources with nothing expected are left
   out. `detail` has the ratio per source. The note lists sources below the gate.
4. If a fetcher throws, its source counts 0 parsed, and the note says `fetcher failed: <ids>`.

This counts items only. Whether each field is right is checked by the dataset test
`evals/dataset.sources.test.ts`, not by this metric.

## The gate

- Soft, at least 0.95. No judge rule.
- A miss shows `FAIL` and does not change the exit code. A parser is losing entries. The note names
  the source. No size rule applies. See [gates](../gates.md).

## Data it uses

The [source recordings](../sets/source-recordings.md).

## How to add a case

Record a new source and check its `expected.json` by hand. See
[source recordings](../sets/source-recordings.md#how-to-refresh-it) and [adding cases](../adding-cases.md).

## Current result

Current result: 100%, pass (scorecard 2026-10-18, profile light; 24 sources). See [results](../results.md#source-parse-yield).
