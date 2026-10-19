# Classifier cases

Part of [Eval sets](README.md).

Sixty feed items with the answer a person would give: which focus area, and how relevant, from 0
to 3. The classifier is run on them and compared with the labels.

## What it contains

One file, `evals/classifier-cases.json`.

```jsonc
{
  "reviewed": true, // set by the maintainer after checking every label
  "cases": [
    {
      "item": { "id": "...", "title": "...", "url": "...", "summary": "..." },
      "expected": { "area": "AI models and tooling", "relevance": 3 },
    },
  ],
}
```

| Part      | Count                                                                                       |
| --------- | ------------------------------------------------------------------------------------------- |
| Cases     | 60: 46 real items copied from the [recorded weeks](recorded-weeks.md) and 14 synthetic ones |
| Areas     | "AI models and tooling" 23, "Platform engineering" 21, "other" 16                           |
| Relevance | 0: 15, 1: 18, 2: 14, 3: 13                                                                  |

The 14 synthetic items are seven edge cases, two each: funding news, a minor patch, a duplicate
post (labeled like its original), marketing, a security advisory, a deprecation and a release
candidate. They sit on `.example` hosts because the recorded weeks hold too few of them.

## Why it exists

The classifier decides what reaches the writers. If it gives a hype post a high relevance or files
a release under the wrong area, the digest suffers before any writer starts. This set measures that
step alone, with no other step in the way.

## Metric it feeds

[Classifier accuracy](../metrics/classifier-accuracy.md). A case is right when the area matches and
the relevance is within 0.5 of the label. The thresholds (`minRelevance`, `maxHype`,
`maxMinorRelease`) are also tuned on these cases; see below.

## How the eval uses it

`classifyStep` runs on all 60 items in one call with the focus areas and source area tags from
**your** config. The labels use the default focus areas. If you changed `focusAreas`, areas will
not match and accuracy drops for that reason alone. Run the eval with the default focus areas.

## Rules the data must follow

`evals/dataset.classifierCases.test.ts` enforces these:

- Exactly 60 cases, `reviewed` true, unique ids and URLs, and each id is the hash of its URL.
- `relevance` is 0, 1, 2 or 3. `area` is a default focus area or `other`.
- At least 40 real items, and each is identical to the item in a recorded week.
- Synthetic items use `.example` hosts, summaries up to 600 characters, and only the 14 listed
  URLs. A duplicate post carries the same label as its original.
- Balance: 10 to 35 cases per area, 8 to 25 per relevance level, and every focus area shows at
  least three of the four levels. Single label edits should not trip these bounds.

## How to extend it

Add an entry to `cases`, then keep the total and the balance rules in step (the test expects 60;
see [adding cases](../adding-cases.md)). People own the labels: an agent may propose, a person
decides, then sets `reviewed`.

## Tuning the thresholds

The same cases tune the classifier thresholds and `guardFlag`. Two commands, described in
[evals/thresholds/README.md](../../../evals/thresholds/README.md):

```bash
pnpm tsx evals/tuneThresholds.ts capture --config data/thresholds/light.json
pnpm tsx evals/tuneThresholds.ts sweep evals/thresholds/raw/<date>-light.json
```

`capture` calls the models once and saves their raw answers. `sweep` runs offline, picks values on
a train split and reports them on a holdout split (the two newest weeks and every third case).
Values in use come from the `light` sweep of 2026-10-17: see [thresholds](../../configuration/thresholds.md).

Note that the sweep's "filter accuracy" (keep an item when its label is 2 or 3) reached 0.867. The
scorecard metric is stricter, area and relevance must both be right, and stood at 28.3%.
