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

[Classifier accuracy](../metrics/classifier-accuracy.md). Since wave 11 a case is right when the
relevance is within one point of the label; the share with the right area and the Spearman rank
correlation are reported next to it. The thresholds (`minRelevance`, `maxHype`, `maxMinorRelease`)
are also tuned on these cases; see below.

## How the eval uses it

`classifyStep` runs on all 60 items in one call with the focus areas and source area tags from
**your** config. The labels use the default focus areas. If you changed `focusAreas`, the area
labels no longer fit and the relevance scores shift too. Run the eval with the default focus areas.

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
pnpm tsx evals/tuneThresholds.ts capture
pnpm tsx evals/tuneThresholds.ts sweep evals/thresholds/raw/<date>-light.json
```

`capture` calls the models once and saves their raw answers. It reads `digest.config.json` and
captures the profile set in that file. To capture another profile, pass `--config` with a copy of
the config that sets it (the README shows how). `sweep` runs offline, picks values on a train split
and reports them on a holdout split (the two newest weeks and every third case). Values in use come
from the `light` sweep of 2026-10-17: see [thresholds](../../configuration/thresholds.md).

The sweep's "filter accuracy" (keep an item when its label is 2 or 3) reached 0.867. The scorecard
metric is a different number. The saved scorecard (2026-10-18) measured exact area and relevance
within 0.5 and stood at 28.3%; the next one uses the within-one rule.

## Calibrating the relevance

Wave 11 (W11-06) added a way to correct the classifier's relevance after the fact. It lives in the
**process step**, not in classify: `src/process/calibration.ts` holds `CalibrationSchema` and
`calibrateClassification`, and `processStep` applies a calibration when it is given one. A
calibration is a monotone map from the raw relevance to a calibrated one on the same 0 to 3 scale,
plus a small bias per area.

```bash
pnpm tsx evals/calibrate.ts evals/thresholds/raw/<date>-light.json [--holdout 2026-W40,2026-W41] [--write [--out <file>]]
```

- It reads the same raw capture as the threshold sweep and makes no model call.
- It fits on the train split only: the labeled classifier cases, and the labeled week items
  (must-include counts as 3, must-exclude as 0). The map is an isotonic fit; the area bias is
  shrunk toward zero and capped at 0.5.
- It then measures the holdout split with the calibration off and on, and prints holdout recall (of
  5), leaks and the within-one share. The verdict is `keep` only when holdout recall rises and
  leaks do not.
- With `--write` and a `keep` verdict it writes `<dataDir>/eval/calibration/<profile>.json`
  (`dist/eval/calibration/` by default), or the file `--out` names.
- `evals/rescoreReplay.ts --calibration <file>` replays classify and process with a file applied.

On the light profile holdout recall did not rise (1.50 to 1.50), so **no calibration file is
committed**. Nothing in the weekly run reads one: `src/digest` does not pass a calibration to the
process step. This is tooling for a profile that needs it.

A third experiment, a pairwise ranking of the best 20 candidates (W11-07, `evals/rescoreReplay.ts
--pairwise on`), lowered holdout recall from 1.50 to 1.00, so it stays off. It is a replay flag, not
a config key, and a real run never sets it.
