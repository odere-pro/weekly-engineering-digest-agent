# Debug a blocked run

Part of [Runbooks](../README.md) / Debug.

## Purpose

Find out why every draft was rejected (status `blocked`, exit code 2), and get a digest out
without weakening the checks.

## When to use

- `pnpm digest history` shows `blocked`, or a note arrived that starts with
  `every draft was rejected`.
- If the status is `failed` with `Every writer failed`, no draft existed at all. Use
  [Debug a failed run](failed-run.md).
- If you think a good item is missing from a digest that was sent, use
  [Missing or wrong item](missing-or-wrong-item.md).

## Prerequisites

- A shell on the machine that runs the digest. In Docker, replace `pnpm digest` with
  `docker compose run --rm digest`.
- Ollama running, to run the week again.

## Steps

1. Open the week. Each rejected draft has a `Rejected:` line with the writer and the check ids.

   ```bash
   pnpm digest show 2026-W40
   ```

   ```text
   Rejected:   gemma4:e4b-mlx by formatCheck
   ```

2. Read the reasons. The `Problems:` list holds what the checks found, cut to 200 characters.

   ```bash
   pnpm digest show 2026-W40 --part drafts
   ```

   ```text
   Writer          Passed  Rejected by  Items  Judge
   gemma4:e4b-mlx  no      formatCheck  1      -

   Problems:
     gemma4:e4b-mlx: Expected 3-5 items, got 2
   ```

3. Look up each check id. `Rejected by` lists every check that said no.

   | Check id              | What it means                                                      | What to do                                                                |
   | --------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------- |
   | `linkCheck`           | A URL is not a collected one, or has no `https://` scheme          | Run again. It cannot be turned off. If it repeats, read the problem lines |
   | `formatCheck`         | Not 3 to 5 items, a missing part, an em dash, or 500 words or more | Run again. If it repeats, change the writer                               |
   | `graniteGroundedness` | A summary, headline or intro is not backed by its sources          | Run again. If it repeats on one writer, replace that writer               |
   | `clefRubric`          | The draft was off task, hype or harmful                            | Read the draft in `drafts.json`, then run again                           |
   | `write`               | A writer made no usable draft while another was rejected           | Check that writer's model and its timeout                                 |

   Link and format problems start with fixed text, such as `Unknown URL not in collected items:`
   and `Malformed or scheme-less link:`.

4. Each writer already got one retry with the problems listed. If the same check fails again
   and again, change something before the next run. The seed is fixed (`models.seed`, default
   42), so an unchanged run often repeats itself. A new seed gives the writers different
   samples.

   ```bash
   pnpm digest run --seed 7
   ```

5. If a guard keeps blocking drafts you judge to be good, read the draft first. Then decide
   with [Change the guard mode](../configure/change-guard-mode.md) (`mode: "all"` blocks only
   when every guard flags) or [Turn a guard on or off](../configure/turn-a-guard-on-or-off.md).

## Verify

`pnpm digest history -n 1` shows `sent`, or `dry-run` if you used `--dry-run`. The failure
note of the blocked run named the check ids, and the new record replaces the old one.

## Roll back

Nothing to undo. A blocked week has no sent digest, so running it again is safe. If you
changed a config key, set it back and restart `serve`.

## Troubleshooting

| Symptom                                   | Cause                                               | Fix                                                                                                                  |
| ----------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| The same check blocks week after week     | A threshold or a model that does not fit your feeds | [Change thresholds](../configure/change-thresholds.md) or [change writers](../configure/change-models-or-writers.md) |
| `Problems:` has no line for a guard check | Only the code checks save their problems            | Read the draft in `drafts.json`                                                                                      |
| The scheduler did not run the week again  | A blocked week is settled; only `failed` is retried | Run `pnpm digest run` yourself                                                                                       |
| `blocked` after you changed `guards`      | `serve` keeps the old config until it restarts      | `docker compose restart digest`                                                                                      |

## Related

- [Checks](../../features/checks.md) and [Guards](../../features/guards.md)
- [Guards configuration](../../configuration/guards.md)
- [src/checks/CLAUDE.md](../../../src/checks/CLAUDE.md) and
  [src/guards/CLAUDE.md](../../../src/guards/CLAUDE.md)
