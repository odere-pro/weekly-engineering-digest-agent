# Format

Part of [Metrics](README.md).

## What it measures

The share of recorded weeks whose digest passes the format check. A week that produced no digest
fails.

## Why it matters

The format check is the contract between the writer and the reader: the right number of items, a
short digest, every part present, no links in the action line. A digest that breaks it is not
sent. If a week produces no digest at all, there is nothing to send, so the metric counts that as a
failure too.

## How it is computed

`formatCompliance` in `evals/metrics.ts`, over the six plain week replays (not the attack replay).

1. `parseDigestMarkdown` reads the written Markdown back into a digest.
2. The real `formatCheck` (`src/checks/formatCheck.ts`) runs on it. It asks for 3 to 5 items, a
   headline, a summary in every item, an action line on `act-now` and `worth-a-look` items, at most
   3 `act-now` items, actions of at most 20 words, summaries of at most 40, no em dash, no link
   in an action and fewer than 500 words.
3. The eval drops two problems, `Missing intro` and `Missing why-it-matters in item N`. The saved
   layout prints neither, so a digest read back from it cannot show them.
4. The value is weeks that passed divided by all weeks, including weeks with no digest.

`byWeek` keeps the first 5 problems per week. A week with no digest shows as `no-digest`.

## The gate

- Hard, at least 1 (100%). No judge rule.
- A miss means a week broke the format or produced nothing. The run exits with 1.
- Fewer than 6 weeks fails too. See [gates](../gates.md).

The newest scorecard misses it because 2026-W36 produced no digest in its first replay. See
[results](../results.md#format).

## Data it uses

The [recorded weeks](../sets/recorded-weeks.md).

## How to add a case

The check runs on every digest, so coverage grows with the recorded weeks. A change to the rules
themselves is a code change in `src/checks/formatCheck.ts`. See [checks](../../features/checks.md).

## Current result

Current result: 83.3% (5 of 6), fail (scorecard 2026-10-18, profile light). See [results](../results.md#format).
