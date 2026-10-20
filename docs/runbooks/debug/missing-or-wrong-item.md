# Debug a missing or wrong item

Part of [Runbooks](../README.md) / Debug.

## Purpose

Find the first step where an item you expected was lost, or where an unwanted item got in, and
turn a real miss into an eval case.

## When to use

- A release that mattered is not in the digest, or an item that should not be there is.
- The digest repeats a story, or an item from an earlier week.
- If the whole week was empty, use [Debug a quiet week](quiet-week.md).

## Prerequisites

- The run folder of the week (`dist/<monday>/digest/`, for `2026-W42` `dist/2026-10-12/digest/`).
  Keep a copy before you change anything. `dist/<monday>/<source>/raw/` holds what each source
  answered, if you need to see the feed itself.
- The item's title or URL, and the source id it should come from.

## Steps

1. Was it collected? Look for the title in the items.

   ```bash
   pnpm digest show 2026-W42 --part items
   ```

   If it is absent, the feed never gave it or it was cut: it is older than `windowDays`, it is
   beyond the cap (`maxItemsPerSource`, default 20, newest first), or the entry had no valid
   link or date. A GitHub source without `GITHUB_TOKEN` reads `releases.atom`, which lists only
   about the latest ten releases. Check the source with `pnpm digest fetch --source <id>`
   ([Failing feed](failing-feed.md)).

2. Did it get scored? Open the scores. A row with `dropped before scoring (input guard)`
   was flagged by the rule guard `ruleInjection` (fixed rules, no model). With
   `models.rescoreWithWriter` on, it can also be `clefPolicy` or `graniteRisk`. Set
   `LOG_LEVEL=debug` before the next run to log which check (`flaggedBy`) in the
   `input guards dropped item` line. The log names the check, not the rule. An item that
   quotes an attack string would trip `ruleInjection`; see
   [Turn a guard on or off](../configure/turn-a-guard-on-or-off.md) if it keeps dropping real news.

   ```bash
   pnpm digest show 2026-W42 --part scores
   ```

3. If it was scored and is `scored, not picked`, find the reason. The run does not save
   reasons, so read the row against this table (first match wins, top to bottom).

   | Reason          | How to see it                                                                 |
   | --------------- | ----------------------------------------------------------------------------- |
   | `sent-before`   | Its URL is in `sentUrls` of a run in the last `dedupeWeeks` weeks (default 4) |
   | `duplicate`     | The same story from another source ranked higher                              |
   | `low-relevance` | `Relevance` below `thresholds.minRelevance` (1.5)                             |
   | `hype`          | `Hype` above `thresholds.maxHype` (60%)                                       |
   | `minor-release` | `Minor` above `thresholds.maxMinorRelease` (75%)                              |
   | `below-top-n`   | It passed, but `topN` (default 5) better items took the places                |

   Ranking goes by relevance, then area confidence, then newest. An area gets at most 2
   places while another area still has an item, so a third item of a busy area can lose to a
   weaker item of a quiet one. Only a run that reached a channel counts as sent: items from a
   dry run can come back.

   One more reason has no row: `process` picked the item, then a model input guard
   (`clefPolicy` or `graniteRisk`) flagged it in `guardCandidates`, and the next eligible item
   took its place. Its scores look like a pick's. With `LOG_LEVEL=debug` the
   `candidate guards dropped item` line names the item and the check (`flaggedBy`).

4. For a repeated story, note the match is narrow on purpose. Two items merge only when they
   come from different sources and share a title, or announce the same `product@version`
   release. A post and a release with no version in the title both pass.
5. For an unwanted item that is in the digest, read what the writers made and who won.

   ```bash
   pnpm digest show 2026-W42 --part drafts
   ```

   ```bash
   pnpm digest show 2026-W42 --part digest
   ```

   The link and format checks only prove that links are collected URLs. They do not judge
   relevance. The `Area` and `Hype` numbers in the scores say how the classifier saw it.

6. Record the miss. Open `dist/<monday>/digest/review.md`: tick a picked item that should not be
   there and a candidate (the 20 best left-out items) that should have been. Then save it.

   ```bash
   pnpm digest feedback 2026-W42
   ```

   This writes `dist/feedback/2026-W42.json`. Keep the run folder. Maintainers turn it into a
   case: see [Add an eval case from a bad week](../maintain/add-eval-case-from-a-bad-week.md).

7. To change behaviour, see [Change thresholds](../configure/change-thresholds.md) and
   [Change focus areas](../configure/change-focus-areas.md). A source `area` is only a hint
   line (`Source tag:`); the classifier still picks the area from `focusAreas` or `other`.

## Verify

You can say at which step the item was lost: not collected, dropped by a guard, filtered by a
threshold or by `sent-before`, cut by `topN`, or left out by the writers.

## Roll back

Steps 1 to 5 only read. Delete `dist/feedback/<week>.json` to undo step 6.

## Troubleshooting

| Symptom                                         | Cause                                            | Fix                                        |
| ----------------------------------------------- | ------------------------------------------------ | ------------------------------------------ |
| A dry run of a sent week shows no new digest    | A forced dry run keeps the sent record and files | Test on a week not yet sent; use the evals |
| `digest feedback` says there is no review sheet | The week has no winner, so no `review.md`        | Pick a week with a digest                  |
| The item is picked but not in `digest.md`       | The winning writer left it out                   | Compare writers in `--part drafts`         |
| Scores look wrong for every item                | Classifier or focus areas do not fit the feeds   | Change focus areas, then run the evals     |

## Related

- [Process](../../features/process.md) and [Classify](../../features/classify.md)
- [Thresholds](../../configuration/thresholds.md) and [Focus areas](../../configuration/focus-areas.md)
- [src/process/CLAUDE.md](../../../src/process/CLAUDE.md) and
  [src/classify/CLAUDE.md](../../../src/classify/CLAUDE.md)
