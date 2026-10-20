# Process

Part of [Features](README.md).

## What it is for

Classify scores every item, but the digest has room for only 3 to 5. This step decides which items
go to the writers. It removes items sent in earlier weeks, duplicates, low-relevance items, hype
and minor releases, then picks the top N with a spread across areas. It is plain code with no
model call, so the same input always gives the same answer.

## Where it sits

It is the fourth step, after classify and before guardCandidates. See
[data flow](../architecture/data-flow.md).

## What it does

- Ranks all items: relevance first (high to low), then area confidence, then the newest date.
- Drops items in a fixed order. An item gets the first reason that fits:
  1. `sent-before`: its URL went out in one of the last `dedupeWeeks` weeks (compared after the URL
     is normalised, so tracking parameters do not hide a repeat);
  2. `duplicate`: the same story as a better-ranked item;
  3. `low-relevance`: relevance below `thresholds.minRelevance` (default 1.5);
  4. `hype`: hype above `thresholds.maxHype` (default 0.6);
  5. `minor-release`: minor-release probability above `thresholds.maxMinorRelease` (default 0.75).
- A duplicate is an item with the same id or, from a different source, the same normalised title
  or the same release (`product@version`, such as a blog post and a GitHub release of one tag).
  The release match is narrow on purpose: a missed merge is left to the writer, a wrong merge
  would drop real news. Two items from the same source are never merged.
- Picks up to `topN` items from the rest. An area gets at most 2 slots while another area still
  has an item, so one topic cannot fill the digest. Items that survive but miss the cut count as
  `below-top-n`.
- Returning fewer than `topN` items is fine. When fewer than 3 are selected, the digest run ends
  the week as `quiet` (exit 3).
- Also returns the eligible items the top N cut left out, best first. `guardCandidates` runs this
  step again without the picks the model input guards flagged, and uses those items to fill its
  next batch. See [guards](guards.md).
- Can apply a relevance calibration when it is given one: a fitted map from the classifier's
  relevance to a corrected value, plus a bias per area, applied before the filters and the ranking.
  A real run never gives it one (no config key, no calibration file committed), so this is idle.
  It was fitted and measured offline by the evals tooling, and holdout recall did not rise.
- Can also take a model-chosen item order (the W11-07 pairwise experiment). Only the eval replay
  sets it, behind a flag; a real run never does, and the experiment stays off.
- The run saves the scores, not the drop reason of each item. In
  `pnpm digest show <week> --part scores` an item is marked "in digest" or "scored, not picked".
  The logs record how many items were selected and dropped.

## What you can configure

- `topN`: 3 to 5, default 5. `dedupeWeeks`: 0 to 12, default 4. See
  [collection limits](../configuration/collection-limits.md).
- `thresholds.minRelevance`, `thresholds.maxHype` and `thresholds.maxMinorRelease`. See
  [thresholds](../configuration/thresholds.md) and the runbook
  [change thresholds](../runbooks/configure/change-thresholds.md).
- The ranking, the duplicate rules and the 2-slot area spread are fixed in code. Relevance
  calibration is not configurable: nothing in config or on disk switches it on.
- All keys: [config keys](../reference/config-keys.md).

## What can go wrong

- The week ends `quiet` because too few items survived. This is often a valid result. See
  [quiet week](../runbooks/debug/quiet-week.md).
- A good item was dropped, or a repeated one got through. See
  [missing or wrong item](../runbooks/debug/missing-or-wrong-item.md). A story that appears under
  two titles with no shared version can pass the duplicate rule.
- Thresholds that are too strict give quiet weeks; too loose lets hype through. Measure changes
  with [must-include recall](../evaluation/metrics/must-include-recall.md) and
  [must-exclude leaks](../evaluation/metrics/must-exclude-leaks.md).
- A bad `topN` or threshold value is caught when the config loads, with a message naming the field.

## Code and tests

- Folder: [src/process/](../../src/process/). Maintainer notes: [CLAUDE.md](../../src/process/CLAUDE.md).
- No port and no adapters. It imports nothing that touches the disk, the clock or the network.
- Tests sit next to the code and build items with the shared test builders in
  [test/builders.ts](../../test/builders.ts).

## Related

- Before: [classify](classify.md). After: [guards](guards.md) (guardCandidates), then
  [write](write.md).
- [store](store.md) supplies the URLs sent in earlier weeks.
- [digest](digest.md) turns a short list into a `quiet` week.
- The threshold sweep that tunes these values lives in [evals](evals.md).
