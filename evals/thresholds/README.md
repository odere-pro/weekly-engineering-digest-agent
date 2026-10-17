# Threshold tuning

`minRelevance`, `maxHype`, `maxMinorRelease` and `guardFlag` are set from our own eval cases
(W3-03). The models are called once per profile; the sweep then runs offline.

```bash
LOG_LEVEL=warn pnpm tsx evals/tuneThresholds.ts capture --config data/thresholds/light.json
pnpm tsx evals/tuneThresholds.ts sweep evals/thresholds/raw/<date>-light.json [--holdout 2026-W40,2026-W41]
```

| File                        | What                                                                                                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `raw/<date>-<profile>.json` | Raw outputs: classify on the 60 classifier cases and every recorded week item, clefPolicy P(yes) and the granite verdict on every week item and attack, clefRubric P(yes) on the grounding drafts |
| `<date>-<profile>.json`     | The sweep: proposed thresholds, accuracy curves, false blocks per guard, the check against the week labels                                                                                        |
| `capture.ts`, `sweep.ts`    | The capture and the sweep; `../tuneThresholds.ts` is the command line                                                                                                                             |

## Method

- An item belongs in the digest when its label is relevance 2 or 3. The classifier thresholds
  are the grid point (step 0.05) that keeps or drops the most of the 60 cases as labelled.
- `guardFlag` is the grid point at which clefPolicy flags the most attack cases while clefPolicy
  (clean week items) and clefRubric (clean control drafts, since it shares `guardFlag`) each flag
  5% or less. Granite gives verdicts, not probabilities, so no threshold changes it.
- Ties go to the point whose neighbours (2 grid steps on every axis) score best, then to the
  point closest to the thresholds in use.

## Profiles

| Profile   | Status                                                                        |
| --------- | ----------------------------------------------------------------------------- |
| `light`   | Measured 2026-10-17 on an M1 Pro (32 GB), Ollama 0.40.4, granite thinking off |
| `quality` | Not measured: it does not run in reasonable time on this laptop               |
| `fast`    | Not measured                                                                  |

## Result: light, 2026-10-17

Thresholds (in use, then proposed): `minRelevance` 1.5 to 1.5, `maxHype` 0.5 to 0.6,
`maxMinorRelease` 0.5 to 0.75, `guardFlag` 0.5 to 0.35.

| Measure                                     | Result                            |
| ------------------------------------------- | --------------------------------- |
| Cases / clean items / attacks               | 60 / 369 / 10                     |
| Filter accuracy (keep iff label is 2 or 3)  | 0.767 in use, 0.867 proposed      |
| Exact match (area and relevance both right) | 0.267 (area 0.70, relevance 0.43) |
| clefPolicy false blocks / attacks caught    | 0.000 / 7 of 10                   |
| granite false blocks / attacks caught       | 0.000 / 2 of 10                   |
| clefRubric false blocks on clean drafts     | 0.000                             |
| Input false blocks, mode "any"              | 0.000                             |
| Failed model calls                          | 0                                 |

## The 80% gate

The gate "classifier accuracy 80% or more on the default profile" means **filter accuracy**:
does the classifier output, cut at the thresholds, keep or drop an item as its label says?
That is what the thresholds control. At the proposed thresholds it is 0.867.

## Known gap

The exact match of area plus relevance is only 26.7%. This is a limit of the 2B light
classifier (W2-05 measured its relevance range as 1.04 to 1.86), not of the thresholds.
It is deferred to the `quality` profile on better hardware.

## Reading the curves

`maxMinorRelease` is flat from 0.65 to 1.0 (0.867), so labels barely pin it down. `maxHype`
peaks at 0.6 but is within 0.02 of that from 0.25 to 0.65. Relevance-only labels do not
separate the two well; treat both as weak.

## Train and holdout split (W6-04)

Before W6-04 the thresholds were chosen and scored on the same labels (F56). `sweep` now picks on
a train split and reports on a holdout split of the same raw capture, with no model calls.

- **Weeks:** the holdout is the two newest recorded weeks (`--holdout <weeks>` takes a comma-separated
  list of week ids instead). Their week items and clean input-guard items never reach the pick. At
  least one week stays in train.
- **Cases:** the holdout is every third classifier case (the 3rd, 6th, ...), every third attack and
  every third grounding case (both of its drafts), in the order they are stored in the raw capture.
  The split is deterministic and disjoint.
- **Output:** train and holdout classifier accuracy, filter accuracy, false blocks (the worst of
  clefPolicy, clefRubric and granite) and attacks caught, side by side with the gap. A gap above
  0.1 prints a `WARNING` line. The result JSON carries `split` and `scores`; files written before
  W6-04 have neither and still parse.
- **Reading the older sections:** every section of the result file now describes the train side. The
  numbers under "Result: light, 2026-10-17" above were picked and scored on all the data and are kept
  as they were.

### Result on the current capture (light, 2026-10-17)

Holdout: 2026-W40 and 2026-W41. Train has 40 cases, 177 clean items, 7 attacks; holdout has 20
cases, 192 clean items, 3 attacks. With 20 holdout cases one case moves filter accuracy by 0.05.

| Thresholds                                                                                     | Filter accuracy, train | Filter accuracy, holdout | False blocks | Attacks caught, train / holdout |
| ---------------------------------------------------------------------------------------------- | ---------------------- | ------------------------ | ------------ | ------------------------------- |
| In use (`1.5 / 0.6 / 0.75 / 0.35`)                                                             | 0.825                  | 0.950                    | 0.000        | 5 of 7 / 2 of 3                 |
| Picked on train (`minRelevance 1.5`, `maxHype 0.35`, `maxMinorRelease 0.65`, `guardFlag 0.35`) | 0.825                  | 0.900                    | 0.000        | 5 of 7 / 2 of 3                 |

The gap is -0.075 (holdout better than train), so there is no overfitting warning. The sweep on
train alone picks `maxHype` 0.35 and `maxMinorRelease` 0.65; the thresholds in use do as well on
train and better on the holdout, so they stay. Classifier accuracy (area and relevance) is 0.300 on
train and 0.200 on the holdout (gap 0.100, not above the limit).
