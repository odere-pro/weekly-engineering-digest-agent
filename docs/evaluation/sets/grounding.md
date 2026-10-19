# Grounding cases

Part of [Eval sets](README.md).

Ten digest drafts, each with one false claim planted in it. The eval checks that the output guards
reject every one, and that they leave the same draft alone once the false claim is removed.

## What it contains

`evals/grounding/grounding-NN-<name>.json`, one file per case, plus a `README.md` with a table.

```jsonc
{
  "id": "grounding-01-wrong-version",
  "plantedItemId": "a2b3556d63f888ab", // the digest item that carries the false claim
  "draft": {
    "writer": "gemma4:31b",
    "digest": { "weekId": "2026-W37", "headline": "...", "items": [] },
  },
  "sources": [], // the collected items the draft cites
}
```

Each draft has three items. The false claim sits in the first, second or third item (across the
cases), and in `summary` except in case 06, where it sits in `whyItMatters`. The ten claims:
a wrong version, an invented benchmark, a wrong date, a feature the source does not mention,
a wrong maturity level, invented adoption, a wrong number, a deprecation reported as a removal,
a wrong attribution and an invented security fix. The table is in
[evals/grounding/README.md](../../../evals/grounding/README.md).

Cases 01, 03 and 07 are subtle on purpose: the claim differs from the source by one digit.

## Why it exists

A writer model can state something its source never said. A reader cannot tell. The output guards
(`graniteGroundedness`, `clefRubric`) are the check for that, so the eval plants known errors and
sees whether they are caught. See [guards](../../features/guards.md).

## Metrics it feeds

- [Groundedness](../metrics/groundedness.md), a hard gate: the planted draft was rejected.
- [Guard false blocks](../metrics/guard-false-blocks.md): the clean controls go through the output
  guards too, and any flag counts against the guard that raised it.

## How the eval uses it

For each case the eval makes a clean control: the same draft without the planted item
(`withoutItem` in `evals/schema.ts`). Both drafts go through the output guards together, with
every output check on and mode `any`. The case is **caught** when the planted draft is rejected.
The control should pass: every claim left in it restates its source.

On the newest scorecard `graniteGroundedness` rejected all 10 planted drafts and no guard flagged
a control.

## Rules the data must follow

`evals/dataset.cases.test.ts` enforces these:

- Ten files named after their case id, with unique ids.
- Sources have distinct URLs on `.example` hosts, real ids (hash of the URL) and summaries of at
  most 600 characters.
- Every digest item has a source with the same id, URL and title.
- The draft passes the link check and the format check, so only grounding can catch it.
- No number appears in an unplanted item unless its source has it. The control must be clean.
- The planted claim, matched by a pattern in the test, is in the planted item only and not in its
  source. The planted position covers the first, second and third item.
- The case is listed in the README. Headlines and intros are neutral so a control never carries a
  claim of its own.

## How to extend it

Write a new file, add the row to the README and add the claim's pattern to `PLANTED_CLAIMS` in the
test. The test expects exactly 10 cases, so a maintainer updates the count with the new case. The
hard gate needs at least 10. See [adding cases](../adding-cases.md).

## Notes

The set is hand-written with invented companies. It does not contain real model mistakes, so a
guard can pass it and still miss a real draft. Real blocked drafts are better material: see
[add an eval case from a bad week](../../runbooks/maintain/add-eval-case-from-a-bad-week.md).
