# View run history

Part of [Runbooks](../README.md) / Observe.

## Purpose

List the past runs, newest first, with their status, item counts, duration and winning writer.
This is the first command to run after any week that did not end well.

## When to use

- You want to know whether last week was sent, quiet, blocked or failed.
- You are on call and a failure note arrived: start here, then open the week with
  [Show a week](show-a-week.md).
- To read one week in full, use [Show a week](show-a-week.md), not this page.

## Prerequisites

- The config file loads (`digest.config.json`), because `history` reads `dataDir` from it.
- No Ollama, no network and no lock are needed. The command only reads `run.json` files.

## Steps

1. List the last runs. The default is 12. `-n` (long form `--limit`) sets another number.

   ```bash
   pnpm digest history -n 4
   ```

   In Docker the prefix is `docker compose run --rm digest`, so the command is
   `docker compose run --rm digest history -n 4`.

2. Read the columns.

   ```text
   Week      Status   Items   Duration  Winner
   2026-W43  quiet    3 → 0   4m 38s    -
   2026-W42  sent     31 → 5  7m 8s     gemma4:e4b-mlx
   2026-W41  failed   28 → 5  6m 8s     gemma4:e4b-mlx
   2026-W40  blocked  30 → 0  13m 8s    -
   ```

   `Items` is items collected, then items in the digest. `Winner` is the writer model tag, or
   `-` when no draft won.

3. Act on the status.

   | Status    | Exit code | Next runbook                           |
   | --------- | --------- | -------------------------------------- |
   | `sent`    | 0         | None                                   |
   | `dry-run` | 0         | None; nothing was sent                 |
   | `quiet`   | 3         | [Quiet week](../debug/quiet-week.md)   |
   | `blocked` | 2         | [Blocked run](../debug/blocked-run.md) |
   | `failed`  | 1         | [Failed run](../debug/failed-run.md)   |

   A `skipped` run (the week was already sent) is never saved, so it does not appear.

4. If a week is missing, list the folders. `history` shows only weeks that have a readable
   `run.json`.

   ```bash
   ls data/runs
   ```

## Verify

The newest row is the week you expect (the ISO week of the last scheduled Monday). Its status
matches the exit code of the run. `No runs yet.` means the data folder has no run at all.

## Roll back

Nothing changed. The command is read-only.

## Troubleshooting

| Symptom                                       | Cause                                               | Fix                                                               |
| --------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------- |
| `No runs yet.`                                | Wrong folder, or no run has finished                | Check `dataDir` in the config; Docker uses `./data`               |
| A week is not listed                          | Older than `keepWeeks`, so only `digest.md` is left | Read `data/runs/<week>/digest.md`                                 |
| A week is not listed (recent)                 | The run never saved a record: lock held, bad config | Read the logs; see [Failed run](../debug/failed-run.md)           |
| Log line `Ignoring unreadable run.json`       | The file is corrupt or belongs to another week      | Re-run the week; see [Re-run a week](../recover/re-run-a-week.md) |
| `-n` is refused: `must be a positive integer` | `-n` takes a whole number of 1 or more              | Pass a positive integer, for example `-n 4`                       |

## Related

- [Show a week](show-a-week.md) and [Triage](../../operations/triage.md)
- [Run record](../../reference/run-record.md) and [Exit codes](../../reference/exit-codes.md)
- [src/cli/CLAUDE.md](../../../src/cli/CLAUDE.md)
