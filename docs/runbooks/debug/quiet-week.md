# Debug a quiet week

Part of [Runbooks](../README.md) / Debug.

## Purpose

Find out where the items of a `quiet` week went, and decide whether the week was truly quiet
or something upstream is wrong. A quiet week has exit code 3 and sends no digest.

## When to use

- `pnpm digest history` shows `quiet`, `digest run` exited 3, or a note said
  `no items collected`.
- A week is quiet when nothing was collected, or when fewer than 3 items are left after the
  `process` step or after the model input guards (`guardCandidates`). Often that is a valid
  result. Check it only when it repeats.
- A week where every source failed is not quiet: it ends `failed` at `collect` with
  `every source failed (24 of 24 sources)`, and the scheduler retries it. Go to
  [Failing feed](failing-feed.md).
- If one feed is the problem, go to [Failing feed](failing-feed.md).

## Prerequisites

- A shell on the machine that runs the digest. In Docker, replace `pnpm digest` with
  `docker compose run --rm digest`.
- Ollama running if you try the experiment in step 4.

## Steps

1. Open the week and read the `Items:` line. It lists the counts in pipeline order.

   ```bash
   pnpm digest show 2026-W43
   ```

   ```text
   Items:      3 collected, 3 after the rule guard, 3 classified, 1 selected (model guards checked 0), 0 in the digest
   ```

   The same numbers are `counts` in `dist/<monday>/digest/run.json`: `collected`,
   `afterGuardInput`, `classified`, `afterProcess`, `selected`, `guardedCandidates`,
   `digestItems`. This week ended at `process`, before the model input guards ran, so
   `guardedCandidates` is 0. Older records, and runs with `models.rescoreWithWriter` on, have no
   `guardedCandidates` and read `after guards`.

2. Find the first count that falls.

   | Where the count falls                                      | Meaning                                                                                             | Next                                                 |
   | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
   | `collected` is 0                                           | Feeds empty in the window, or some feeds failed                                                     | Read `Source failed:` lines; step 5                  |
   | `after the rule guard` or `after guards` below `collected` | The rule guard dropped items (in older records or with `models.rescoreWithWriter`, any input guard) | `show --part scores`; guard settings                 |
   | `selected` below `classified`                              | `process` dropped items (step 3)                                                                    | Step 3                                               |
   | `selected` is 1 or 2                                       | Fewer than 3 survived, so the week is quiet                                                         | Step 4                                               |
   | `selected` below 3, with `model guards checked`            | The model input guards flagged picks and too few eligible items were left                           | The `Candidate guards done` log line; guard settings |

   When nothing was collected, a failure note is sent, although the status is `quiet`. A quiet
   week with items collected sends no note.

   ```text
   Weekly digest 2026-W43 failed at collect: no items collected (3 of 24 sources failed)
   ```

   If every source failed, the status is `failed`, not `quiet`, and the note counts them:

   ```text
   Weekly digest 2026-W43 failed at collect: every source failed (24 of 24 sources), so no items were collected
   ```

3. Work out why `process` dropped an item. The reasons are not saved, so compare the scores
   with the thresholds.

   ```bash
   pnpm digest show 2026-W43 --part scores
   ```

   An item gets the first reason that fits, in this order:

   | Reason          | How to see it                                                     |
   | --------------- | ----------------------------------------------------------------- |
   | `sent-before`   | Its URL is in `sentUrls` of a run in the last `dedupeWeeks` weeks |
   | `duplicate`     | The same story came from two sources; the better ranked one stays |
   | `low-relevance` | `Relevance` is below `thresholds.minRelevance` (default 1.5)      |
   | `hype`          | `Hype` is above `thresholds.maxHype` (default 60%)                |
   | `minor-release` | `Minor` is above `thresholds.maxMinorRelease` (default 75%)       |

   To test `sent-before`, search the earlier runs for the item URL:

   ```bash
   grep -l 'https://github.com/ollama/ollama/releases/tag/v0.41.0' dist/*/digest/run.json
   ```

4. Try a longer window as a dry run. It sends nothing. The window is 1 to 31 days.

   ```bash
   pnpm digest run --dry-run --since 14d
   ```

   Items sent in the last weeks stay excluded. If the result is still quiet, the exit code is 3.

5. Choose a fix and apply it with the matching runbook:
   - Feeds fail or are empty: [Failing feed](failing-feed.md), [Add a source](../configure/add-a-source.md).
   - Good items score low: [Change focus areas](../configure/change-focus-areas.md) or
     [Change thresholds](../configure/change-thresholds.md).
   - The window is too short for slow feeds: raise `windowDays` (see
     [Collection limits](../../configuration/collection-limits.md)).
   - None of these: the week was quiet. Do nothing.

## Verify

For a fix, run the week for real with `pnpm digest run --since 14d` and read the status in
`pnpm digest history -n 1`. It must say `sent`.

## Roll back

A dry run replaces the record of a week that was not sent with a `dry-run` record. If it is
still the current week, the next `serve` start sees a `dry-run` week and runs it for real
(catch-up). Run the week yourself after the experiment to stay in control. Revert any config
key you changed.

## Troubleshooting

| Symptom                                    | Cause                              | Fix                                                       |
| ------------------------------------------ | ---------------------------------- | --------------------------------------------------------- |
| `collected` 0 and no `Source failed:` line | The window held no entries         | Step 4, or raise `windowDays`                             |
| `classified` far below `collected`         | The rule guard flagged many items  | [Guard settings](../../configuration/guards.md); `doctor` |
| Quiet every week, no note                  | Items are collected, then filtered | Step 3                                                    |
| The dry run wrote `<week>.md`              | It found 3 or more items           | Run for real                                              |

## Related

- [Run a dry run](../run/dry-run.md) and [Triage](../../operations/triage.md)
- [Process](../../features/process.md) and [Exit codes](../../reference/exit-codes.md)
- [src/process/CLAUDE.md](../../../src/process/CLAUDE.md)
