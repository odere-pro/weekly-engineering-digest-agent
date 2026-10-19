# Source summary fill

Part of [Metrics](README.md).

## What it measures

The share of parsed feed items whose summary has at least 40 characters, pooled over all sources.

## Why it matters

The classifier and the writers work from the title and the summary. An item with no summary leaves
them guessing. Some feeds carry only a title, a link and a date. The pipeline then fetches the
article page to fill the text in. This metric shows whether that works.

## How it is computed

`sourceSummaryFill` in `evals/metrics.ts`, on the results of `evaluateSources`.

1. The real fetchers run over the recordings, with the recorded article pages served for any page
   request.
2. A summary is empty when, after trimming, it has fewer than `MIN_SUMMARY_CHARS` (40) characters.
3. Per source: parsed items minus empty summaries, divided by parsed items.
4. The value is the pooled ratio. `detail` has the ratio per source, and the note lists the
   sources below the gate (`below the gate: vllm-releases`).

## The gate

- Soft, at least 0.9. No judge rule.
- A miss shows `FAIL` and does not change the exit code. Summaries are missing and the cause is in
  the feed or in the page fetching. The pooled value can pass while one source is under the gate:
  the note names it. No size rule applies. See [gates](../gates.md).

## Data it uses

The [source recordings](../sets/source-recordings.md), including the saved article pages.

## How to add a case

Record a new source, and its pages with `--pages` if its feed has no text. See
[source recordings](../sets/source-recordings.md#how-to-refresh-it).

## Current result

Current result: 98.9%, pass (scorecard 2026-10-18, profile light; `vllm-releases` is at 80%). See [results](../results.md#source-summary-fill).
