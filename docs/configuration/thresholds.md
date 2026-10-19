# Thresholds

Part of [Configuration](README.md).

Thresholds are the cut-off numbers that decide which items are dropped before writing, and when a
decision-model guard raises a flag. The defaults were tuned on a sweep over 60 labelled items
with the `light` profile. They are not tuned for `quality` or `fast`.

| Key                          | Type   | Default | Range  | Drops or flags                                             |
| ---------------------------- | ------ | ------- | ------ | ---------------------------------------------------------- |
| `thresholds.minRelevance`    | number | 1.5     | 0 to 3 | Items with expected relevance **below** this are dropped   |
| `thresholds.maxHype`         | number | 0.6     | 0 to 1 | Items with hype probability **above** this are dropped     |
| `thresholds.maxMinorRelease` | number | 0.75    | 0 to 1 | Items with minor-release probability **above** are dropped |
| `thresholds.guardFlag`       | number | 0.35    | 0 to 1 | A decision-model guard flags when P(yes) is **above** this |

```json
{
  "thresholds": {
    "minRelevance": 1.5,
    "maxHype": 0.6,
    "maxMinorRelease": 0.75,
    "guardFlag": 0.35
  }
}
```

## What the numbers mean

The classifier answers four questions for every item that passed the input guards:

| Question       | Answer                                    | Compared with                  |
| -------------- | ----------------------------------------- | ------------------------------ |
| `relevance`    | Expected level on a 0 to 3 scale          | `minRelevance`                 |
| `area`         | One of your focus areas, or `other`       | Not a threshold. Spreads picks |
| `hype`         | Probability the item is hype or marketing | `maxHype`                      |
| `minorRelease` | Probability it is a minor version bump    | `maxMinorRelease`              |

The process step drops an item for the first reason that fits, in this order: sent before,
duplicate, low relevance, hype, minor release. Then it keeps the top `topN`.

`guardFlag` is a different kind of threshold. It belongs to the two `clef` guards,
`clefPolicy` and `clefRubric` (see [guards](guards.md)). The Granite guards and the rule guard
`ruleInjection` ignore it.

The process step can also replace each item's relevance with a calibrated value before it applies
`minRelevance` and ranks the items. That code exists, but nothing feeds it: there is no config key
and no calibration file is committed, so a real run uses the classifier's relevance as it is. The
fitting tool is for maintainers, and the last trial did not raise recall on held-out weeks.

## Which way to move them

| Goal                             | Move                                                       |
| -------------------------------- | ---------------------------------------------------------- |
| More items reach the writers     | Lower `minRelevance`; raise `maxHype` or `maxMinorRelease` |
| Fewer, more important items      | Raise `minRelevance`; lower the other two                  |
| Fewer false blocks by the guards | Raise `guardFlag` (less strict)                            |
| Catch more attacks               | Lower `guardFlag` (more strict)                            |

Moving a threshold changes what each week contains. A week with fewer than 3 items left ends
`quiet`. Re-run [the evals](../runbooks/run/run-evals.md) after a change you plan to keep, because
the numbers trade attack handling against false blocks.

## Check what a threshold did

```bash
pnpm digest show 2026-W42 --part scores
```

The table lists each item's relevance, area, hype and minor-release probabilities, and whether it
was `in digest` or `scored, not picked`. It does not store the reason an item was dropped.

## Change it

- [Change thresholds](../runbooks/configure/change-thresholds.md)
- [Missing or wrong item](../runbooks/debug/missing-or-wrong-item.md)
- [Quiet week](../runbooks/debug/quiet-week.md)

## Related

- [Process feature](../features/process.md) and [classify feature](../features/classify.md)
- [Classifier accuracy metric](../evaluation/metrics/classifier-accuracy.md)
- [Collection limits](collection-limits.md): `topN`
