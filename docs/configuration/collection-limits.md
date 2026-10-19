# Collection limits

Part of [Configuration](README.md).

These six keys decide how much the agent collects, how many items reach the digest, how long
history is kept, and where it is stored.

| Key                 | Type    | Default | Limits    | What it sets                                                                 |
| ------------------- | ------- | ------- | --------- | ---------------------------------------------------------------------------- |
| `windowDays`        | integer | 7       | 1 to 31   | How far back to collect, in days                                             |
| `maxItemsPerSource` | integer | 20      | 1 to 100  | Newest items kept from each source                                           |
| `topN`              | integer | 5       | 3 to 5    | Items in the digest                                                          |
| `dedupeWeeks`       | integer | 4       | 0 to 12   | Weeks of sent URLs removed from new digests                                  |
| `keepWeeks`         | integer | 12      | 1 or more | Weeks kept in full, with their fetched data and logs. At least `dedupeWeeks` |
| `dataDir`           | string  | `dist`  | not empty | Where runs, fetched data, logs and the lock live                             |

```json
{
  "windowDays": 7,
  "maxItemsPerSource": 20,
  "topN": 5,
  "dedupeWeeks": 4,
  "keepWeeks": 12,
  "dataDir": "dist"
}
```

## Collecting

- `windowDays` is the age limit for an item. A run collects items published in the last
  `windowDays` days. `digest run --since 14d` overrides it for one run (1d to 31d).
- `maxItemsPerSource` caps each source after sorting newest first. A source can set its own cap
  with the `maxItems` field of that source (1 to 100). See [sources](sources.md).
- GitHub's Atom feed keeps only 10 releases per repository, so a busy repo can lose items
  whatever you set here.

## Choosing

- `topN` is the most items the digest holds. The process step picks up to `topN`, with at most 2
  from one area while other areas still have items. The format check wants 3 to 5 items.
- A week with fewer than 3 items worth sending ends `quiet` and sends no digest. Lowering `topN`
  does not change that minimum.
- `dedupeWeeks` removes URLs already sent in the previous N weeks. `0` turns the cross-week
  check off. Only weeks that reached a channel count: a `sent` week, or a `failed` week that was
  delivered to some channel.

## Storing

- `keepWeeks`: after each run, weeks older than `keepWeeks` weeks are pruned: they lose their
  source data and everything in their `digest/` folder except `digest.md` and the delivered
  `<week>.md`, `<week>.html` and `<week>.failed.md`, and the fetched data and logs of their days go
  too (see [disk and pruning](../operations/disk-and-pruning.md)). There is no upper limit. `keepWeeks` below `dedupeWeeks` is refused, because pruned
  weeks would drop out of the dedupe.
- `dataDir` is relative to the folder you run from. Under it: `<monday>/digest/` (a week's run),
  `<monday>/<source>/` (what each source answered that week), `<day>/<source>/` (`digest fetch`),
  `logs/<day>/digest.log`, `digest.lock`, `feedback/`, `eval/checkpoints/` and `artifacts/` (the
  `pnpm build` output). See [files and paths](../reference/files-and-paths.md). The folder must be
  on a local disk that supports hard links. `digest doctor` checks that it is writable (`data dir`).
- In Docker the folder `./dist` is mounted at `/app/dist`, the default `dataDir`. Keep `dataDir` at
  `dist`, or the history is written inside the container and lost with it.

## Change it

- [Change thresholds](../runbooks/configure/change-thresholds.md) if you want fewer or more items to pass
- [Prune disk](../runbooks/maintain/prune-disk.md)
- [Force a week](../runbooks/run/force-a-week.md) to run a week again

## Related

- [Thresholds](thresholds.md): what drops an item before `topN` applies
- [Data layout](../architecture/data-layout.md) and [files and paths](../reference/files-and-paths.md)
- [Disk and pruning](../operations/disk-and-pruning.md)
- [Process feature](../features/process.md)
