# Remove or disable a source

Part of [Runbooks](../README.md) / [Configure](README.md).

## Purpose

Stop collecting from one source. The config has no per-source "disabled" switch, so you do it by
removing the entry and keeping a copy to put back later.

## When to use

- A feed is dead, noisy or off topic.
- You want to pause a source for a while.
- To fix a feed that should work, use [Failing feed](../debug/failing-feed.md) or
  [Update a source](update-a-source.md) first.

## Prerequisites

- Write access to `digest.config.json`.
- At least one other source stays in the list. The schema needs 1 or more
  (`Too small: expected array to have >=1 items` at `sources`).

## Steps

1. Know the reason there is no switch. The source schema has only `id`, `kind`, `url`, `area`
   and `maxItems`. A key such as `"disabled": true` is accepted and then ignored without a
   message, so the source would keep running. Do not rely on it.
2. Keep a copy of the whole file, or of the entry, outside the config. Nothing reads other files.

   ```bash
   cp digest.config.json digest.config.json.bak
   ```

3. In `digest.config.json`, delete the whole object of that source from the `sources` array.
   Mind the commas: the last entry has none. Before and after, for a list that keeps one entry:

   ```json
   {
     "sources": [{ "id": "example-blog", "kind": "rss", "url": "https://example.com/feed.xml" }]
   }
   ```

4. Check the file still loads.

   ```bash
   pnpm digest doctor
   ```

5. Apply the change. `digest serve` reads the config once, at start. In Docker:
   `docker compose restart digest`. A manual `pnpm digest run` and a host timer read the file
   again each time. In Docker, other commands are `docker compose run --rm digest <command>`.

## Verify

- `pnpm digest doctor` has no `source <id>` line for the removed source and no `✗ config` line.
- `pnpm digest fetch --source <id>` now says `Unknown source: <id>` and lists the ids that remain.
- After the next run, `pnpm digest show <week> --part items` has no rows from it.

## Roll back

Put the entry back into `sources` (or restore the copy) and restart as in step 5. Then test it
with `pnpm digest fetch --source <id>`.

What stays the same while it is out:

- Dedupe works on URLs from past digests, not on sources. Removing a source does not make old
  items come back, and re-adding it does not repeat what was already sent within `dedupeWeeks`.
- Old run folders keep the items and `failedSources` they recorded.

## Troubleshooting

| Symptom                                       | Cause                                            | Fix                                                         |
| --------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------- |
| `Too small: expected array to have >=1 items` | The list is empty                                | Keep at least one source                                    |
| `Invalid JSON in ...`                         | A comma is left over or missing                  | Fix the comma at the removed entry                          |
| The source still runs                         | You added `disabled`, or did not restart `serve` | Delete the entry; restart                                   |
| Weeks turn `quiet` after the removal          | Fewer than 3 items are left after filtering      | Add other sources; see [Quiet week](../debug/quiet-week.md) |
| `Unknown source: <id>` when you run `fetch`   | Expected: the source is gone                     | Use an id that is still in the file                         |

## Related

- [Add a source](add-a-source.md), [Update a source](update-a-source.md)
- [Sources](../../configuration/sources.md), [Config keys](../../reference/config-keys.md)
- [src/sources/CLAUDE.md](../../../src/sources/CLAUDE.md)
