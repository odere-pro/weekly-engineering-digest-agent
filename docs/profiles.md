# Profiles: measured speed and quality

This page holds the numbers the README profile table points to. They come from
`pnpm digest eval --profile <name>` on the reference hardware. Nothing here is guessed.

## Reference hardware

- Apple M1 Pro, 32 GB RAM, macOS, Ollama on the host, `OLLAMA_MAX_LOADED_MODELS=1`.
- Guard thinking off (the default since W2-07). Every guard on, mode `any`.
- Thresholds from the light-profile sweep (W3-03): `minRelevance` 1.5, `maxHype` 0.6,
  `maxMinorRelease` 0.75, `guardFlag` 0.35.

## Results

| Profile   | Measured   | Run time per week                    | Hard gates                                                       | Soft gates                                                                                                                 | Writer win rate                         |
| --------- | ---------- | ------------------------------------ | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `light`   | 2026-10-17 | 317 s mean, 207 s to 509 s           | 3 of 4 pass: links 100%, attacks 100%, grounded 100%, format 67% | false blocks 0% (pass); must-include recall 1.00 (gate 3); must-exclude leaks 0.67 (gate 0.5); classifier 27%; stability 0 | `gemma4:e4b-mlx` 100% (the only writer) |
| `fast`    | no         | not measured on the reference laptop | not measured                                                     | not measured                                                                                                               | not measured                            |
| `quality` | no         | not measured on the reference laptop | not measured                                                     | not measured                                                                                                               | not measured                            |

The `light` row is the baseline scorecard `evals/scorecards/2026-10-17-light.json`: 6 recorded weeks,
60 classifier cases, 10 attacks, 10 grounding cases. The whole eval set took 43 minutes.

## How to read the light row

- **Run time** is one replayed week: collect from the recording, guards, classify, write, check.
  The slowest weeks (2026-W40, 2026-W41) had the most items.
- **Format 67%** means 4 of 6 weeks produced a digest that passed the format check (3 to 5 items,
  under 500 words, no em dash, every section present). A week with no surviving draft counts as a
  failure: in 2026-W39 the only draft failed the link check. This is the open hard gate for v0.1.0.
- **Classifier 27%** is the exact match of area and relevance on the 60 labeled cases. The filter
  decision alone (keep or drop) is right 87% of the time at the tuned thresholds. The 2B light
  classifier gives nearly every item a relevance between 1.0 and 1.9, so it barely separates items.
- **Must-include recall 1.00 and leaks 0.67** are per-week averages against the hand labels: about
  one labeled must-include item per week makes the digest, and about two thirds of a must-exclude
  item leaks in.
- **Stability 0** is the count of consecutive weeks with every check green. It rises as weeks pass.
- **Writing quality and selection agreement** need a judge model. The light profile has none, so
  they are not measured.

## Why fast and quality are not measured

The quality profile writes with two 30B-class models and judges with `clef:latest`. One week took
hours on the reference laptop under load (see the W2-05 notes in the run history). The fast profile
shares the 30B writer. Both wait for a machine with more memory bandwidth. Until then the README
marks them "not measured" and the light profile is the default for evals.

## How to measure again

```bash
pnpm digest eval --profile light
```

The scorecard lands in `evals/scorecards/<date>-<profile>.json`. Commit it with the release and
update the table above. Run one profile at a time; the evals load one model after another.
