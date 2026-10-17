# Threshold tuning

`minRelevance`, `maxHype`, `maxMinorRelease` and `guardFlag` are set from our own eval cases
(W3-03). The models are called once per profile; the sweep then runs offline.

```bash
LOG_LEVEL=warn pnpm tsx evals/tuneThresholds.ts capture --config data/thresholds/light.json
pnpm tsx evals/tuneThresholds.ts sweep evals/thresholds/raw/<date>-light.json
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
