# Disk and pruning

Part of [Operations](README.md).

## What grows

| What                     | Where                                               | Size                                                       |
| ------------------------ | --------------------------------------------------- | ---------------------------------------------------------- |
| Models                   | Ollama store, or the `ollama-models` volume         | 20 to 66 GB (see [cost](../overview/cost-and-hardware.md)) |
| Run folders              | `dist/<monday>/digest/`                             | small, one per week                                        |
| Source data of a run     | `dist/<monday>/<source>/raw`, `formatted`           | the feed answers as served (up to 5 MiB each), per week    |
| Digest files             | `dist/<monday>/digest/`, or `delivery.markdown.dir` | a few KB per week                                          |
| Logs                     | `dist/logs/<day>/digest.log`                        | one file per day, pruned with the old weeks                |
| Fetch and preview output | `dist/<day>/<source>/`, `digest/preview/`           | only when you ask for it; old days are pruned              |
| Scorecards               | `evals/scorecards/`                                 | one JSON per eval run                                      |

## Automatic pruning

At the end of each run, the weeks older than `keepWeeks` (default 12) are emptied: that Monday's
source folders go, and so does everything in its `digest/` folder except `digest.md` and the
delivered `<week>.md`, `<week>.html` and `<week>.failed.md` (leftover `.tmp` files go too).

The fetched data and logs of those days go as well. Every day before the Monday of the oldest kept
week loses its source folders (a day with no `digest/`, such as an old `digest fetch` day, is
deleted whole) and its `logs/<day>/` folder. A `delivery.markdown.dir` outside the data folder is
never pruned. Pruning is best effort: a failure is logged and never fails the run.

`keepWeeks` must be at least `dedupeWeeks` (default 4), because pruned weeks drop out of the
cross-week dedupe and the digest could repeat items.

## What you may delete by hand

- Old `dist/<monday>/` folders, but keep at least `dedupeWeeks` recent weeks.
- Logs and `digest fetch` folders you want gone sooner than pruning removes them: `dist/logs/<day>/`,
  the `dist/<day>/` folders of days that are not a run's Monday, and any `digest/preview/`. Always
  safe.
- Models you no longer use: `ollama rm <tag>`.

Never delete `dist/digest.lock` while a run is going. See [lock](lock.md).

## Related

- [Prune disk](../runbooks/maintain/prune-disk.md)
- [Collection limits](../configuration/collection-limits.md), [data layout](../architecture/data-layout.md)
