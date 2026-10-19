# Change thresholds

Part of [Runbooks](../README.md) / [Configure](README.md).

## Purpose

Move the cut-off points that decide which scored items reach the writers and when a guard flags.
Do it when the digest is too thin, too noisy, or blocks good content.

## When to use

- Weeks come out `quiet` although the feeds had news ([Quiet week](../debug/quiet-week.md)).
- Hype or patch releases keep getting through.
- A decision-model guard flags items you judge fine ([Blocked run](../debug/blocked-run.md)).
- To change how many items a digest holds, edit `topN` (3 to 5); that is not a threshold.

## Prerequisites

- A saved week to look at: `pnpm digest show <week> --part scores` shows relevance, hype and
  minor-release odds for each item.
- Read the warning in step 1. The defaults were tuned on one profile only.
- Write access to `digest.config.json`.

## Steps

1. Know what you are changing. All four sit under `thresholds`.

   | Key                          | Range  | Default | Effect                                                        |
   | ---------------------------- | ------ | ------- | ------------------------------------------------------------- |
   | `thresholds.minRelevance`    | 0 to 3 | 1.5     | Items rated below this are dropped (`low-relevance`)          |
   | `thresholds.maxHype`         | 0 to 1 | 0.6     | Items with a hype probability above this are dropped          |
   | `thresholds.maxMinorRelease` | 0 to 1 | 0.75    | Items with a minor-release probability above this are dropped |
   | `thresholds.guardFlag`       | 0 to 1 | 0.35    | `clefPolicy` and `clefRubric` flag when P(yes) is above this  |

   Raise `minRelevance` for fewer, stronger items. Lower `maxHype` or `maxMinorRelease` to drop
   more. Lower `guardFlag` to flag more; raise it to flag less. A value equal to `guardFlag`
   does not flag. The Granite checks give a verdict, not a probability, so `guardFlag` never
   changes them.

   The defaults come from a sweep on the `light` profile only (2026-10-17). `quality` and `fast`
   have no tuning. Change one value at a time, by a small step.

2. Edit `digest.config.json`. Leave out keys you do not change.

   ```json
   {
     "thresholds": {
       "minRelevance": 1.2,
       "maxHype": 0.6
     }
   }
   ```

3. Apply the change. `digest serve` reads the config once, at start. In Docker:
   `docker compose restart digest`. A manual `pnpm digest run` and a host timer read the file
   again each time. In Docker, other commands are `docker compose run --rm digest <command>`.
4. Run `pnpm digest doctor` to confirm the file loads.

## Verify

- Run a week and open `pnpm digest show <week> --part scores`. Items with a `Status` of
  `in digest` should now match what you wanted. Items cut by a threshold read
  `scored, not picked`.
- For more than a hunch, replay the recorded eval weeks with your config:
  `pnpm digest eval --profile light` ([Run evals](../run/run-evals.md)). It is slow. Compare the
  classifier, must-include and must-exclude measures with the last scorecard. Maintainers re-baseline
  with [Re-baseline evals](../maintain/re-baseline-evals.md).

## Roll back

Delete the keys you added, or set the defaults from the table, and restart as in step 3.

## Troubleshooting

| Symptom                                                           | Cause                                         | Fix                                             |
| ----------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------- |
| `Too big: expected number to be <=1` at `thresholds.maxHype`      | Probabilities go from 0 to 1                  | Use a value from 0 to 1                         |
| `Too big: expected number to be <=3` at `thresholds.minRelevance` | Relevance goes from 0 to 3                    | Use a value from 0 to 3                         |
| The change has no effect                                          | A misspelled key is dropped without a message | Compare the key with the table; restart `serve` |
| Digest is `quiet` after raising `minRelevance`                    | Fewer than 3 items pass                       | Lower it again                                  |
| More bad content gets through after raising `guardFlag`           | Guards flag less                              | Lower `guardFlag` toward 0.35                   |

## Related

- [Thresholds](../../configuration/thresholds.md), [Config keys](../../reference/config-keys.md)
- [Change focus areas](change-focus-areas.md), [Change guard mode](change-guard-mode.md)
- [src/process/CLAUDE.md](../../../src/process/CLAUDE.md), [evals/thresholds/README.md](../../../evals/thresholds/README.md)
