# Grounding cases

Part of [Eval sets](README.md).

Thirty digest drafts, each with one false claim planted in it. The eval checks that the output
guards reject every one, and that they leave the same draft alone once the false claim is removed.
The saved scorecard (2026-10-18) used the first 10; the next one will use all 30.

## What it contains

`evals/grounding/grounding-NN-<name>.json`, one file per case, plus a `README.md` with the tables.

```jsonc
{
  "id": "grounding-01-wrong-version",
  "plantedItemId": "a2b3556d63f888ab", // the digest item that carries the false claim
  "heldOut": true, // cases 21 to 30 only
  "draft": {
    "writer": "gemma4:31b",
    "digest": { "weekId": "2026-W37", "headline": "...", "items": [] },
  },
  "sources": [], // the collected items the draft cites
}
```

Each draft has three items. The false claim sits in the first, second or third item (across the
cases), and in `summary` except in case 06, where it sits in `whyItMatters`.

| Cases | Set      | What the claims are                                                                                                                                                                                                         |
| ----- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01-10 | Original | A wrong version, an invented benchmark, a wrong date, an unmentioned feature, a wrong maturity level, invented adoption, a wrong number, a deprecation reported as a removal, a wrong attribution, an invented security fix |
| 11-20 | Subtler  | A version one minor higher, a number or date off by a little, a feature that belongs to another item of the same digest, beta reported as stable, a widened scope. Also open for tuning                                     |
| 21-30 | Held out | A patch version, a latency, a date, a duration or a requirement off by a little, a feature from another item, a flipped default, a swapped licence or component, a widened platform. Never used to tune                     |

Cases 01, 03 and 07 are subtle on purpose: the claim differs from the source by one digit. In
cases 11 to 30 the other two items are cut to their first two source sentences, so they add no
number or claim the source lacks. The tables are in
[evals/grounding/README.md](../../../evals/grounding/README.md).

## Why it exists

A writer model can state something its source never said. A reader cannot tell. The output guards
(`graniteGroundedness`, `clefRubric`) are the check for that, so the eval plants known errors and
sees whether they are caught. The later cases are subtler and a third is held out, so the set can
show whether the guards generalise. See [guards](../../features/guards.md).

## Metrics it feeds

- [Groundedness](../metrics/groundedness.md), a hard gate: the planted draft was rejected.
- [Guard false blocks](../metrics/guard-false-blocks.md): the clean controls go through the output
  guards too, and any flag counts against the guard that raised it.

## How the eval uses it

For each case the eval makes a clean control: the same draft without the planted item
(`withoutItem` in `evals/schema.ts`), so every control has two items. Both drafts go through the
output guards together, with every output check on and mode `any`. The case is **caught** when the
planted draft is rejected. The control should pass: every claim left in it restates its source.

On the saved scorecard `graniteGroundedness` rejected all 10 planted drafts and no guard flagged a
control. The 20 cases added since have not been scored.

## Rules the data must follow

`evals/dataset.cases.test.ts` enforces these:

- Thirty files named after their case id, with unique ids.
- Sources have distinct URLs on `.example` hosts, real ids (hash of the URL) and summaries of at
  most 600 characters.
- Every digest item has a source with the same id, URL and title.
- The draft passes the link check and the format check, so only grounding can catch them.
- No number appears in an unplanted item unless its source has it. The control must be clean.
- The planted claim, matched by a pattern in the test, is in the planted item only and not in its
  source. The planted position covers the first, second and third item.
- Every case is listed in the README. The "Held-out set" table lists exactly 21 to 30, and exactly
  those files carry `"heldOut": true`.

## Held-out cases are never used to tune

Never tune a guard question or `guardFlag` on cases 21 to 30, and do not read them while you edit
the guard prompts: a case you have read is no longer held out. Add new cases instead.
The schema reads `heldOut`, and the threshold sweep always puts these cases on its holdout side,
so no threshold is picked on them.

## How to extend it

Write a new file, add the row to the README and add the claim's pattern to `PLANTED_CLAIMS` in the
test. The test expects exactly 30 cases, so a maintainer updates the count with the new case. The
hard gate needs at least 30. See [adding cases](../adding-cases.md).

## Notes

The set is hand-written with invented companies. It does not contain real model mistakes, so a
guard can pass it and still miss a real draft. Real blocked drafts are better material: see
[add an eval case from a bad week](../../runbooks/maintain/add-eval-case-from-a-bad-week.md).
