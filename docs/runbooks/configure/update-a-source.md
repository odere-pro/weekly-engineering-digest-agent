# Update a source

Part of [Runbooks](../README.md) / [Configure](README.md).

## Purpose

Change one entry of `sources` in `digest.config.json`: its URL, id, kind, `area` hint or
`maxItems` cap, without losing the rest of the setup.

## When to use

- A feed moved to a new URL, or a feed answers with a redirect to another host.
- A noisy source needs a lower `maxItems`, or its `area` hint is wrong.
- You want to rename an id.
- To add a new source use [Add a source](add-a-source.md). To drop one use
  [Remove or disable a source](remove-or-disable-a-source.md).

## Prerequisites

- `pnpm digest doctor` runs. A `!` on the source you change is fine; that is often why you are here.
- The new URL, opened in a browser or checked with `curl`, returns a feed.
- Write access to `digest.config.json`.

## Steps

1. Keep a copy. The file holds no secrets, so the copy is safe to keep next to it.

   ```bash
   cp digest.config.json digest.config.json.bak
   ```

2. In `digest.config.json`, find the entry by its `id` and change only what you need.

   ```json
   {
     "sources": [
       {
         "id": "example-blog",
         "kind": "rss",
         "url": "https://example.com/new-path/feed.xml",
         "area": "platform",
         "maxItems": 5
       }
     ]
   }
   ```

   | Change in a `sources` entry | Effect                                                                        |
   | --------------------------- | ----------------------------------------------------------------------------- |
   | `url`                       | A different feed. Items already sent stay excluded (dedupe is by URL)         |
   | `id`                        | New name in items and run records. Old run folders keep the old id            |
   | `kind`                      | Must fit the URL: `github` needs `https://github.com/<owner>/<repo>`          |
   | `area`                      | Only a hint to the classifier. Delete the key to send no hint                 |
   | `maxItems`                  | Newest items kept from this source. Delete the key to use `maxItemsPerSource` |
   | Position in list            | When two sources return the same URL, the earlier one in the list wins        |

3. Test the one source. It calls no model and takes no lock.

   ```bash
   pnpm digest fetch --source example-blog
   ```

4. Run `pnpm digest doctor` and read the `source example-blog` line.
5. Apply the change. `digest serve` reads the config once, at start. In Docker:
   `docker compose restart digest`. A manual `pnpm digest run` and a host timer read the file
   again each time. In Docker, other commands are `docker compose run --rm digest <command>`.

## Verify

- `pnpm digest fetch --source example-blog` prints `ok` in the `Status` column.
- `pnpm digest doctor` prints `✓ source example-blog: reachable and readable`.
- After the next run, `pnpm digest show <week>` lists no `Source failed:` line for it.

## Roll back

Put the copy back, then restart as in step 5.

```bash
cp digest.config.json.bak digest.config.json
```

## Troubleshooting

| Symptom                                                | Cause                                        | Fix                                                   |
| ------------------------------------------------------ | -------------------------------------------- | ----------------------------------------------------- |
| `Unknown source: <id>` from `fetch`                    | The id was renamed, or `-c` points elsewhere | Use the id as it is now in the file                   |
| `HTTP 404 fetching <id>`                               | The new URL is wrong                         | Open it in a browser and copy the feed address        |
| `<id> redirected to <host>, which is not its own host` | The feed moved to another host               | Set `url` to the final address                        |
| `Source <id> is not a GitHub repository URL`           | `kind` is `github` but the URL is not a repo | Use `https://github.com/<owner>/<repo>`               |
| `source ids must be unique`                            | The new id is already used                   | Pick another id                                       |
| The edit changes nothing                               | Key misspelled (unknown keys are dropped)    | Compare with the table above; keys are case-sensitive |

## Related

- [Sources](../../configuration/sources.md), [Collection limits](../../configuration/collection-limits.md)
- [Failing feed](../debug/failing-feed.md)
- [Config keys](../../reference/config-keys.md)
