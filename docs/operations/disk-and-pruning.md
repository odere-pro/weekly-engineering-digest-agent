# Disk and pruning

Part of [Operations](README.md).

## What grows

| What                     | Where                                       | Size                                                       |
| ------------------------ | ------------------------------------------- | ---------------------------------------------------------- |
| Models                   | Ollama store, or the `ollama-models` volume | 20 to 66 GB (see [cost](../overview/cost-and-hardware.md)) |
| Run folders              | `data/runs/<week>/`                         | small, one per week                                        |
| Digest files             | `dist/digests` or `data/digests`            | a few KB per week                                          |
| Fetch and preview output | `dist/fetch`, `dist/preview`                | only when you ask for it                                   |
| Scorecards               | `evals/scorecards/`                         | one JSON per eval run                                      |

## Automatic pruning

At the end of each run, run folders older than `keepWeeks` (default 12) are emptied except for
`digest.md`. Pruning is best effort: a failure is logged and never fails the run.

`keepWeeks` must be at least `dedupeWeeks` (default 4), because pruned weeks drop out of the
cross-week dedupe and the digest could repeat items.

## What you may delete by hand

- Old `data/runs/<week>/` folders, but keep at least `dedupeWeeks` recent weeks.
- `dist/fetch/` and `dist/preview/`: always safe.
- Models you no longer use: `ollama rm <tag>`.

Never delete `data/digest.lock` while a run is going. See [lock](lock.md).

## Related

- [Prune disk](../runbooks/maintain/prune-disk.md)
- [Collection limits](../configuration/collection-limits.md), [data layout](../architecture/data-layout.md)
