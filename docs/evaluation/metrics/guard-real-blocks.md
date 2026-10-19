# Guard blocks on real weeks

Part of [Metrics](README.md).

Metric id `guardRealBlocks`. Added in wave 11. No scorecard has a value for it yet.

## What it measures

The share of week replays where an output guard rejected every draft, so the week got no digest.
The three stability runs of each week count too: 18 replays for 6 weeks.

## Why it matters

[Guard false blocks](guard-false-blocks.md) only sees the clean control drafts of the grounding
cases, which are short and synthetic. On the wave 6 scorecard it showed 1.7% while 2 of 18 real
replays had no digest (the notes in `evals/README.md` blame the output guard). A guard that
blocks a real week costs a digest. This metric asks the same question on the real drafts.

## How it is computed

`guardRealBlocks` in `evals/metrics/guards/guardRealBlocks.ts`, fed by `replayEndOf` in
`evals/scoring/replaySamples.ts`.

1. The harness wraps the output guards in every week replay and keeps each verdict with its reason.
2. A replay is a **guard block** when its run ended `blocked`, it had at least one draft, and a
   guard is among the rejecters of every draft. A draft rejected only by the link check, the format
   check or a failed writer does not count, and neither does a run that ended any other way.
3. The value is blocked replays divided by replays.
4. `detail` has `runs`, `blockedRuns` and, per output guard (`graniteGroundedness`, `clefRubric`),
   the share of replays it took part in blocking. `byWeek` has one line per replay (a repeat is
   numbered, `2026-W36 (2)`), and a blocked one reads `blocked by <guard>: <reason>`, cut to 200
   characters.

The replay turns the template fallback digest off (`noFallback`). In a real run the fallback sends a
template digest when every draft is rejected, so the week ends `sent` and not `blocked`. The eval
wants the block itself, so it shows. The same reasons feed the "why a week has no digest" lines of
[format](format.md) and [stability](stability.md).

## The gate

- Soft, at most 0.05 (5%). No judge rule.
- A miss shows `FAIL` and does not change the exit code. With 18 replays one blocked replay is
  already 5.6%, so the gate allows none at the spec size.
- With fewer than 6 weeks the note says so; the verdict stays. See [gates](../gates.md).

## Data it uses

The [recorded weeks](../sets/recorded-weeks.md), replayed three times each
([stability runs](../sets/stability.md)). It costs no extra model call.

## How to add a case

Not applicable as a case file. It uses the replays that already run, so more recorded weeks give more
replays. To reduce blocks, change a guard or a writer, then run the `weeks` section again
([running sections](../running-sections.md)).

## Current result

Current result: no scorecard value yet (the saved scorecard 2026-10-18, profile light, was written before this metric). See [results](../results.md#guard-blocks-on-real-weeks).
