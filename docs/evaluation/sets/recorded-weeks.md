# Recorded weeks

Part of [Eval sets](README.md).

Six real weeks of collected feed items, frozen on disk, with the maintainer's picks. The eval
replays each week through the pipeline as if it were the current week.

## What it contains

`evals/weeks/<week>/` for 2026-W36 to 2026-W41. Each folder has three files.

| File            | What                                                                                  |
| --------------- | ------------------------------------------------------------------------------------- |
| `items.json`    | Every item the feeds served for that ISO week (an array of `Item`)                    |
| `labels.json`   | `mustInclude` (exactly 5 ids), `mustExclude` (any number of ids) and a `notes` string |
| `candidates.md` | A numbered list of the items with id, source, date, URL and summary, for labeling     |

| Week     | Items | Sources | Must-exclude |
| -------- | ----- | ------- | ------------ |
| 2026-W36 | 31    | 8       | 10           |
| 2026-W37 | 48    | 12      | 12           |
| 2026-W38 | 47    | 11      | 12           |
| 2026-W39 | 51    | 9       | 13           |
| 2026-W40 | 88    | 16      | 15           |
| 2026-W41 | 104   | 16      | 19           |

## Why it exists

It is the only set that tests the whole pipeline on realistic input: collect, guards, classify,
rank, write, checks, select. The labels say which five items a good digest holds
(`mustInclude`) and which hype or minor releases it must leave out (`mustExclude`).

## Metrics it feeds

- [Link validity](../metrics/link-validity.md) and [format](../metrics/format.md): the digest of
  each week is checked.
- [Must-include recall](../metrics/must-include-recall.md) and
  [must-exclude leaks](../metrics/must-exclude-leaks.md): the digest is compared with the labels.
- [Stability](../metrics/stability.md), [run time](../metrics/run-time.md),
  [writer win rate](../metrics/writer-win-rate.md) and [writing quality](../metrics/writing-quality.md).
- [Guard false blocks](../metrics/guard-false-blocks.md): the input guards check these items, and
  the set treats all of them as clean.
- [Guard blocks on real weeks](../metrics/guard-real-blocks.md): how many of the replays had every
  draft rejected by an output guard.
- The first week is also the base of the attack replay ([attacks](attacks.md)).

## How the replay uses it

The fake fetchers serve each source's newest items up to the cap production uses for that source
(its `maxItems`, else `maxItemsPerSource`). A labeled item beyond the cap is **not visible**: it
counts as neither found nor leaked. Today one must-exclude label in 2026-W39 is not visible.
Must-include recall counts the top 5 whatever `topN` is in your config.

## How it was made

```bash
pnpm eval:record
```

`evals/recordWeeks.ts` collects the last 6 complete ISO weeks before the current one, with up to
100 items per source. Sources come from `digest.config.json`, or the default list when that file
is missing. It never deletes: items already in `items.json` stay, and new ones are added. It
writes `labels.json` only when the file does not exist and rewrites `candidates.md` every time.
It warns about a week with fewer than 10 items and lists sources that failed.

Run later, it records newer weeks in new folders. The eval replays **every** week folder, so each
new week adds three replays to the run time.

## Labeling and extending

- Read `candidates.md`, pick the five ids and the exclusions, and write them into `labels.json`.
  After review, set `notes` to `agent-proposed, maintainer-reviewed YYYY-MM-DD` (a test checks it).
- To label a real week from your own runs, run `digest feedback <week>` and then
  `pnpm tsx evals/feedbackToLabels.ts <week>`. It adds missed items as must-include and wrong
  picks as must-exclude, never changes an existing label and prints `CONFLICT` lines.
  It warns when must-include does not hold exactly 5 ids: fix that by hand.

## Rules the data must follow

- Every item is published inside its week (the loader checks), and ids are hashes of the URL.
- `mustInclude` has exactly 5 unique ids. No id is in both lists. Every id is in `items.json`.
- Attack items must not share an id or URL with a week item.
- People own the labels. The recorders never overwrite them.

More: [adding cases](../adding-cases.md), [stability](stability.md).
