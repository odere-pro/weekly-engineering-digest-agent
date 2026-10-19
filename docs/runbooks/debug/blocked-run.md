# Debug a blocked run or a fallback digest

Part of [Runbooks](../README.md) / Debug.

## Purpose

Find out why every writer draft was rejected, and get a model-written digest out without weakening
the checks. When no draft survives, the run builds a fallback digest from the items' own text and
sends it (status `sent`, exit 0). Only if that fallback cannot be built does the week end `blocked`
(exit 2).

## When to use

- A digest ends with "Written from the sources' own words.", or `pnpm digest history` shows
  `fallback` in the winner column. That is a fallback digest: no model wrote it.
- `pnpm digest history` shows `blocked`, or a note arrived that starts with
  `every draft was rejected`. This is now rare.
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
   In a fallback week the summary also says `Winner:     fallback`.

   ```bash
   pnpm digest show 2026-W40
   ```

   ```text
   Winner:     fallback
   Rejected:   gemma4:e4b-mlx by formatCheck
   ```

   `pnpm digest show 2026-W40 --part run` has `"fallback": true`. A `Rejected: fallback by ...` line
   means an output guard flagged the fallback. It is advisory: the digest was still sent.

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
   samples. A week that is already `sent` (a fallback week is) needs `--force`. Add `--dry-run`
   to try it without sending a second digest.

   ```bash
   pnpm digest run --dry-run --force --seed 7
   ```

5. If a guard keeps rejecting drafts you judge to be good, read the draft first. Then decide
   with [Change the guard mode](../configure/change-guard-mode.md) (`mode: "all"` rejects only
   when every guard flags) or [Turn a guard on or off](../configure/turn-a-guard-on-or-off.md).
6. To replace a fallback digest that was already sent, run the week with `--force` once a dry run
   gives a model-written digest. Every channel then gets a second message. See
   [Force a week](../run/force-a-week.md).

## Verify

`pnpm digest history -n 1` shows `sent` (or `dry-run`) with a writer's model tag in the winner
column, not `fallback`. For a rare `blocked` week, the new record replaces the old one.

## Roll back

Nothing to undo. A blocked week has no sent digest, so running it again is safe. A fallback
digest that was sent stays sent; a later forced run only adds a second message. If you changed a
config key, set it back and restart `serve`.

## Troubleshooting

| Symptom                                                                      | Cause                                                              | Fix                                                                                                                  |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| The same check rejects week after week                                       | A threshold or a model that does not fit your feeds                | [Change thresholds](../configure/change-thresholds.md) or [change writers](../configure/change-models-or-writers.md) |
| `Problems:` has no line for a guard check                                    | Only the code checks save their problems                           | Read the draft in `drafts.json`                                                                                      |
| Log says `The fallback digest failed its own checks; the week stays blocked` | A bug in the fallback text builder                                 | Keep `drafts.json` and the log line, and report it. Run the week again for a model-written digest                    |
| The scheduler did not run the week again                                     | `blocked` and fallback weeks are settled; only `failed` is retried | Run `pnpm digest run` (add `--force` for a `sent` week) yourself                                                     |
| Still rejected after you changed `guards`                                    | `serve` keeps the old config until it restarts                     | `docker compose restart digest`                                                                                      |

## Related

- [Checks](../../features/checks.md) and [Guards](../../features/guards.md)
- [Fallback digest](../../features/digest.md#fallback-digest)
- [Guards configuration](../../configuration/guards.md)
- [src/checks/CLAUDE.md](../../../src/checks/CLAUDE.md) and
  [src/guards/CLAUDE.md](../../../src/guards/CLAUDE.md)
