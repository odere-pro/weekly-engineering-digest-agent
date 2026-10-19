# Show a week

Part of [Runbooks](../README.md) / Observe.

## Purpose

Read what a past run saved: a summary, the collected items, the scores, the drafts and the
digest. You can do this at any time, with no Ollama and no network.

## When to use

- After any run, to see counts, timings, the winner and the error.
- To find out why an item is in the digest or is not: see
  [Missing or wrong item](../debug/missing-or-wrong-item.md).
- To see how the digest looks in each channel without sending: use
  [Preview a week](../run/preview-a-week.md).

## Prerequisites

- A run folder for the week: `<dataDir>/<monday>/digest/` (default `dist/<monday>/digest/`), where
  `<monday>` is the Monday of the ISO week: `2026-W43` is `dist/2026-10-19/digest/`.
- A valid config, because `show` reads `dataDir` from it. Secrets are removed from the output.
- The week as an ISO week id, for example `2026-W43`.

## Steps

1. Print the summary.

   ```bash
   pnpm digest show 2026-W43
   ```

   ```text
   Week 2026-W43: quiet
   Profile:    light
   Started:    2026-10-19T07:45:03Z (4m 38s)
   Items:      3 collected, 3 after guards, 3 classified, 1 selected, 0 in the digest
   Winner:     none
   Delivered:  none
   Guards off: none
   Timings:    collect 6.2s, guardInput 41.0s, classify 38.0s, process 0.0s
   ```

   Failed weeks add `Error:` with the step, rejected drafts add `Rejected:` lines and failed
   feeds add `Source failed:` lines. A week sent as the fallback digest (no model wrote it) shows
   `Winner:     fallback`. The summary has no separate fallback line: `--part run` shows
   `"fallback": true`, and `--part drafts` lists the writer `fallback` after the rejected writers.

2. Open one part with `--part`.

   | `--part` | File read     | Shows                                                      |
   | -------- | ------------- | ---------------------------------------------------------- |
   | `items`  | `items.json`  | Source, title, date and URL of every collected item        |
   | `scores` | `scores.json` | Relevance, area, hype and minor-release odds, and a status |
   | `drafts` | `drafts.json` | Each writer: passed, rejected by, item count, judge score  |
   | `digest` | `digest.md`   | The winning digest as text                                 |
   | `run`    | `run.json`    | The full run record as JSON                                |
   | `review` | `review.md`   | The tick sheet for `digest feedback`                       |

   ```bash
   pnpm digest show 2026-W43 --part scores
   ```

   ```text
   Item                       Relevance  Area              Hype  Minor  Status
   v0.41.0                    2.6        ai-tooling (91%)  5%    10%    scored, not picked
   Introducing Example Model  2.2        ai-models (84%)   72%   2%     scored, not picked
   ```

   `Status` is `in digest`, `scored, not picked`, or `dropped before scoring (input guard)`.
   It does not give the reason an item was left out. Read the numbers against the
   [thresholds](../../configuration/thresholds.md).

3. Print the saved JSON as it is with `--json`, for a script.

   ```bash
   pnpm digest show 2026-W43 --part scores --json
   ```

4. In Docker, use `docker compose run --rm digest show 2026-W43`. The same files are in
   `./dist/2026-10-19/digest/` on the host.

## Verify

The summary shows the week, status and counts you expect. `Items` reads left to right as the
pipeline does: collected, after the input guards, classified, selected, in the digest.

## Roll back

Nothing changed. `show` only reads.

## Troubleshooting

| Symptom (message)                                    | Cause                                          | Fix                                     |
| ---------------------------------------------------- | ---------------------------------------------- | --------------------------------------- |
| `No saved run for 2026-W44`                          | No `run.json` for that week                    | [View run history](view-run-history.md) |
| `Week 2026-W43 has no digest.md (run status: quiet)` | The run never got that far                     | Read the summary instead                |
| `"x" is not an ISO week id like 2026-W42`            | Wrong week format                              | Use `YYYY-Www`, for example `2026-W43`  |
| `Unknown part "foo"; use items, scores, drafts, ...` | Part name is not one of the six                | Pick a name from the table              |
| `scores.json does not have the expected shape`       | The file was edited or is from another version | Re-run the week or restore the file     |
| A week past `keepWeeks` shows only the digest        | Pruning keeps `digest.md` only                 | `show <week> --part digest` still works |

## Related

- [View run history](view-run-history.md) and [Preview a week](../run/preview-a-week.md)
- [Run record](../../reference/run-record.md) and [Files and paths](../../reference/files-and-paths.md)
- [src/cli/CLAUDE.md](../../../src/cli/CLAUDE.md)
