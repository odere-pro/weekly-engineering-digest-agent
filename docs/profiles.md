# Profiles: measured speed and quality

The numbers behind the profile table in [how-it-works](how-it-works.md#profiles). They come from
`pnpm digest eval --profile <name>` on the reference hardware. Nothing here is guessed.

## Reference hardware

- Apple M1 Pro, 32 GB RAM, macOS, Ollama on the host, `OLLAMA_MAX_LOADED_MODELS=1`.
- Guard thinking off. Every guard on, mode `any`. Seeded, fixed-temperature runs (W7-03).
- Thresholds from the light-profile sweep (W3-03): `minRelevance` 1.5, `maxHype` 0.6,
  `maxMinorRelease` 0.75, `guardFlag` 0.35.

## Results

| Profile   | Measured   | Run time per week          | Hard gates                                                           | Soft gates                                                                                                                                                                                                                     | Writer win rate                         |
| --------- | ---------- | -------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| `light`   | 2026-10-18 | 340 s mean, 208 s to 582 s | 3 of 4 pass: links, attacks, grounded 100%; format 83% (W36 blocked) | guard attack recall 100%, false blocks 1.7%, source parse 100%, summary fill 98.9% (pass); must-include recall 1.33 (gate 3), must-exclude leaks 0.67 (gate 0.5), classifier 28%, stability 1.67 (gate 4) (fail); quality 3.62 | `gemma4:e4b-mlx` 100% (the only writer) |
| `fast`    | no         | not measured               | not measured                                                         | not measured                                                                                                                                                                                                                   | not measured                            |
| `quality` | no         | not measured               | not measured                                                         | not measured                                                                                                                                                                                                                   | not measured                            |

The `light` row is `evals/scorecards/2026-10-18-light.json`: 6 recorded weeks, 60 classifier cases,
20 attacks, 10 grounding cases, 24 source recordings, every guard on, writing quality scored by
`clef:latest` (reported, not gated: the judge is not calibrated). `fast` and `quality` wait for a
machine with more memory bandwidth.

- **Format 83%**: 2026-W36 produced no digest in its first replay. The output guard blocked the draft.
- **Stability 1.67** is the mean overlap of three runs of 2026-W36, the first week. The gate asks
  for 4 of 5 items in common. W36 had one blocked run; runs 2 and 3 matched on all 5 items. The
  scorecard lists each week's own overlap under `byWeek`: five of five on W37, W38, W40 and W41,
  and a blocked run on W36 and W39.
- **Classifier 28%** is the exact match of area and relevance on the 60 labeled cases (area 68%,
  relevance 42%). The 2B light classifier is the ceiling here.
- A labeled must-exclude item (2026-W39) lies outside the replay window and counts as neither
  found nor leaked (`detail.notVisible`).

## How to measure again

```bash
EVAL_JUDGE=clef:latest pnpm digest eval --profile light   # EVAL_JUDGE optional; also read from .env
```

The scorecard lands in `evals/scorecards/<date>-<profile>.json`; a second run on the same day
overwrites it, so copy the first under another name (`evals/scorecardCompat.test.ts` reads
`2026-10-17-light.json`). Run one profile at a time; the evals load one model after another.
Light takes about 110 minutes, because every recorded week runs three times for stability.

## Calibrating the judge

The judge's scores are gated only when it agrees with the maintainer at least 80% of the time.
`evals/judge/grades.template.json` is the sheet for the 10 hand-graded digests: copy it to
`evals/judge/grades.json` and fill it in. After the judge has scored the same digests,
`pnpm exec tsx evals/judge/calibrate.ts` writes `evals/judge/calibration.json`. It calls no model.
