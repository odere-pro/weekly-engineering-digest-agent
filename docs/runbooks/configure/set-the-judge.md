# Set the judge

Part of [Runbooks](../README.md) / [Configure](README.md).

## Purpose

Turn the judge on or off. The judge is a model that picks the best draft when several writers
produced one. You control it through the size of the writer panel; there is no judge key.

## When to use

- You want two or more writers compared (judge on), or one writer and a faster run (judge off).
- To change which model writes, see [Change models or writers](change-models-or-writers.md).

## Prerequisites

- `pnpm digest doctor` shows no `✗` line.
- Enough time and memory: every extra writer adds a write call (up to 600 s by default), and the
  judge adds one short call per passing draft. Models load one at a time.
- The model `clef:latest` is installed and is a decision model: `ollama pull clef:latest`.

## Steps

1. Know the rules. They come from `src/config/profiles.ts` and `src/digest/stages/selectWinner.ts`.

   | Setup                                          | Judge         | Select step |
   | ---------------------------------------------- | ------------- | ----------- |
   | Profile `quality`, no `models.writers`         | `clef:latest` | Runs        |
   | Profile `fast` or `light`, no `models.writers` | None          | Skipped     |
   | `models.writers` with 2 or more tags           | `clef:latest` | Runs        |
   | `models.writers` with 1 tag                    | None          | Skipped     |

   On a machine without Apple silicon every profile falls back to one writer (`gemma4:31b`) and
   no judge, unless you set `models.writers`. The judge never shares a model family with a
   writer: such a panel fails when the config loads, with a message naming both.

   The judge scores each passing draft from 1 to 5 on accuracy, clarity, why it matters and focus
   fit. The best mean wins. A tie goes to the writer listed first. If only one draft passes the
   checks, no judge call is made. If the judge fails, the first passing draft wins and the run
   goes on.

2. Edit `digest.config.json`. Two writers, so the judge runs:

   ```json
   {
     "models": {
       "writers": ["gemma4:e4b-mlx", "gemma4:31b-mlx"]
     }
   }
   ```

   To turn the judge off on `quality`, give `models.writers` one tag. To use the profile's own
   panel again, delete `models.writers`.

3. Apply the change. `digest serve` reads the config once, at start. In Docker:
   `docker compose restart digest`. A manual `pnpm digest run` and a host timer read the file
   again each time. In Docker, other commands are `docker compose run --rm digest <command>`.
4. Run `pnpm digest doctor`.

Do not confuse this with `EVAL_JUDGE`. That is an environment variable for `digest eval` only: it
names a model that scores winning digests of a profile without a judge, and the scores are only
reported. It has no effect on `digest run`, and it is not the judge a `models.writers` list gets.

## Verify

- With a judge, doctor lists `✓ model clef:latest: installed (decision model)`.
- After a run, `pnpm digest show <week> --part drafts` has a number in the `Judge` column for each
  passing draft. With one passing draft, or no judge, the column shows `-`.

## Roll back

Restore the old `models.writers` (or delete the key) and restart as in step 3.

## Troubleshooting

| Symptom                                       | Cause                                      | Fix                                                                           |
| --------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------- |
| `✗ model clef:latest: not installed`          | The judge model is missing                 | `ollama pull clef:latest`                                                     |
| `installed, but it is not a decision model`   | Another model took the tag `clef:latest`   | Pull the right model again                                                    |
| `Judge` column shows `-` with two writers     | Only one draft passed, or the judge failed | Read the log line `Winner chosen` (`judged` flag) and `drafts` for rejections |
| Setting `EVAL_JUDGE` changed nothing in a run | It is an eval-only variable                | Use `models.writers` as above                                                 |
| You need a judge other than `clef:latest`     | The tag is fixed in the code               | It needs a code change in `src/config/profiles.ts`                            |

## Related

- Writing quality is not gated yet. The quality and selection-agreement gates apply only when the
  judge agrees with a human at least 80% of the time, and no calibration is committed.
  The judge's pick is a helper, not a proven match for your taste.
  See [Judge](../../configuration/judge.md) and
  [Writing quality](../../evaluation/metrics/writing-quality.md).
- [Models](../../configuration/models.md), [Config keys](../../reference/config-keys.md)
- [src/select/CLAUDE.md](../../../src/select/CLAUDE.md)
