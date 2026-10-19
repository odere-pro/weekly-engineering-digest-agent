# Run evals

Part of [Runbooks](../README.md) / Run.

## Purpose

Replay the recorded weeks and the labeled cases through the real pipeline and models, and print a
scorecard with 18 measurements and a pass or fail for the hard gates. It also saves the scorecard.
A part of it can run alone, a lost run can be finished, and two scorecards can be compared.

## When to use

- After a change to a prompt, a threshold, a model, a guard or a writer, to see if quality moved.
  Changed only a guard or the classifier? Run just that section (step 4): it takes minutes.
- To make a new baseline: then follow [Re-baseline evals](../maintain/re-baseline-evals.md).
- Not to check a live install. Use `digest doctor` and a [dry run](dry-run.md) for that.

## Prerequisites

- Run from the root of a clone. `digest eval` reads `evals/` in the current folder, so Docker is
  a poor fit: the scorecard is written inside the container and `--rm` deletes it.
- The models of the profile are pulled (`digest doctor`). One model loads at a time
  (`OLLAMA_MAX_LOADED_MODELS=1`).
- Time and a quiet machine. `light` took about 110 minutes on the last full run, because every
  recorded week runs three times for stability. The data has since grown to 32 attacks and 30
  grounding drafts, so expect a longer guard part. No new time has been measured. `quality` and `fast` are not measured. Run **one profile at a time**
  and do not run anything else heavy on Ollama meanwhile.
- Optional judge: `EVAL_JUDGE` is a model tag (`clef:latest`) that scores the winning digests of a
  profile that has no judge of its own (`light`, `fast`). It must be installed and be a decision
  model. Unset, writing quality is not measured. It can sit in `.env` or the shell.
- Use a config without writer overrides when you want a baseline: `models.writers` changes the
  writers the eval measures.

## Steps

1. Check the setup.

   ```bash
   pnpm digest doctor
   ```

2. Run one profile. Without `--profile` it uses the profile in your config. `--profile all` runs
   `quality`, `fast` and `light` one after the other, which is rarely what you want.

   ```bash
   EVAL_JUDGE=clef:latest pnpm digest eval --profile light
   ```

3. Read the printed scorecard: a header (profile, date, case counts, judge agreement), a table of
   metric, value, gate and `PASS` or `FAIL`, then `Details`, `Week problems`, `Item ids by run` and
   `Notes`. The last line is `Hard gates: PASS` or `Hard gates: FAIL (<ids>)`.
4. Keep the file. It is saved as `evals/scorecards/<date>-<profile>.json` (UTC date). **A second
   run on the same day and profile overwrites it**, so copy the first under another name.
   `evals/scorecardCompat.test.ts` reads `2026-10-17-light.json`: never overwrite or rename that one.

The four hard gates (link validity, attack handling, groundedness, format) must be 100%. Soft gates
only show pass or fail. See [Gates](../../evaluation/gates.md).

The faster options below are flags of `digest eval`; see
[Running parts of the eval](../../evaluation/running-sections.md).

**Run one section.** `--only` takes `guards`, `classify`, `sources` or `weeks`, and saves a partial
scorecard (`<date>-<profile>-partial-<section>.json`). A partial run prints its gates but always
exits 0.

```bash
pnpm digest eval --profile light --only guards
```

**Finish a lost run.** `--resume` reuses the week replays a lost run saved (Ollama dropped, the
machine slept). They are saved under `<dataDir>/eval/checkpoints/<date>/` as each ends, and
`--resume` reads the newest folder. A replay runs again when the git commit, an uncommitted change,
the config, the profile or a model changed.

```bash
pnpm digest eval --profile light --resume
```

**Compare two scorecards.** `--compare` needs exactly two files. It runs nothing and needs no
Ollama.

```bash
pnpm digest eval --compare evals/scorecards/2026-10-17-light.json evals/scorecards/2026-10-18-light.json
```

## Verify

- Exit code 0 and `Hard gates: PASS`. Exit 1 means a hard gate failed; that is a result, not a
  crash. Read `Week problems` and the [metric pages](../../evaluation/metrics/README.md).
- The scorecard file exists. `pnpm vitest run evals/scorecardCompat.test.ts` still passes.

## Roll back

Nothing outside `evals/scorecards/` and the checkpoint folder `<dataDir>/eval/checkpoints/` changes.
Delete the new file, or restore a committed one with `git restore evals/scorecards/<file>`. Delete
the checkpoint folder of a date to forget its replays. The replay uses an in-memory store and
delivers nothing.

## Troubleshooting

| Symptom                                                            | Cause                                     | Fix                                                                                 |
| ------------------------------------------------------------------ | ----------------------------------------- | ----------------------------------------------------------------------------------- |
| `Unknown profile "x". Use quality, fast, light or all.`            | Misspelled profile                        | Use one of the four names.                                                          |
| `Unknown section "x". Use guards, classify, sources, weeks.`       | Misspelled `--only` value                 | Use one of the four sections.                                                       |
| `--compare needs two scorecard files: --compare <a.json> <b.json>` | One file, or three                        | Give exactly two saved scorecards.                                                  |
| `--resume` ran everything again                                    | The commit, config or models changed      | Resume only works on the same code and config; run the same checkout.               |
| `The eval judge "..." (EVAL_JUDGE) is not installed in Ollama`     | The judge tag is not pulled               | `ollama pull <tag>`, or unset `EVAL_JUDGE`.                                         |
| `... installed, but it is not a decision model`                    | The tag lacks the `decision` capability   | Use a decision model such as `clef:latest`.                                         |
| `Cannot check the eval judge ... so nothing was replayed`          | Ollama is down                            | Start Ollama and run again.                                                         |
| `Ollama is missing models for profile "..."`                       | A model of that profile is not pulled     | Run the `ollama pull` lines from `doctor`.                                          |
| `Writing quality` shows `n/a`                                      | No judge scored the digests               | Set `EVAL_JUDGE`.                                                                   |
| A week shows `no digest` under `Week problems`                     | The guards or checks rejected every draft | Read the listed problems; see [How evals work](../../evaluation/how-evals-work.md). |

## Related

- [How evals work](../../evaluation/how-evals-work.md), [Results](../../evaluation/results.md),
  [Running parts of the eval](../../evaluation/running-sections.md)
- [Re-baseline evals](../maintain/re-baseline-evals.md), [Eval feature](../../features/evals.md)
- [evals/CLAUDE.md](../../../evals/CLAUDE.md)
