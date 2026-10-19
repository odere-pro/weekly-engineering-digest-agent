# Add a source

Part of [Runbooks](../README.md) / [Configure](README.md).

## Purpose

Collect releases or posts from one more RSS/Atom feed or GitHub repository. The new source is
read on the next run.

## When to use

- You want a feed that is not in the default list ([docs/sources.md](../../sources.md)).
- To change a source you already have, use [Update a source](update-a-source.md). To drop one,
  use [Remove or disable a source](remove-or-disable-a-source.md).
- A feed that is already listed but fails: see [Failing feed](../debug/failing-feed.md).

## Prerequisites

- `pnpm digest doctor` shows no `✗` line ([First run](../set-up/first-run.md)).
- The feed URL (RSS 2.0 or Atom), or the GitHub repository URL.
- Write access to `digest.config.json`. A `GITHUB_TOKEN` is optional (it only raises rate limits).

## Steps

1. Open `digest.config.json`. Add one object to the `sources` array, after the last entry. This
   shows only the new entries; keep every existing one.

   ```json
   {
     "sources": [
       {
         "id": "example-blog",
         "kind": "rss",
         "url": "https://example.com/blog/feed.xml",
         "area": "platform",
         "maxItems": 10
       },
       {
         "id": "example-releases",
         "kind": "github",
         "url": "https://github.com/example-org/example-repo"
       }
     ]
   }
   ```

   | Key in each `sources` entry | Rule                                                                                  |
   | --------------------------- | ------------------------------------------------------------------------------------- |
   | `id`                        | Required. Lowercase letters, digits and dashes. Unique in the list                    |
   | `kind`                      | `rss` (RSS or Atom) or `github` (releases of one repository)                          |
   | `url`                       | Required. No `user:pass@`. A `github` URL must be `https://github.com/<owner>/<repo>` |
   | `area`                      | Optional hint for the classifier, free text. It is not a focus area                   |
   | `maxItems`                  | Optional, 1 to 100. Default: `maxItemsPerSource` (20)                                 |

2. Test the feed before the next run. It calls no model and takes no lock.

   ```bash
   pnpm digest fetch --source example-blog
   ```

   ```text
   Source        Status  HTTP  Items  Skipped  Time  Error
   example-blog  ok      200   3      0        0.4s

   1 source: 1 ok, 0 failed, 3 items
   Saved to /work/digest/dist/fetch/2026-10-19T08-00-00-000Z
   ```

   Zero items can be normal for a quiet feed. Try `--since 14d` to look further back.

3. Run `pnpm digest doctor`. The new feed gets one line.
4. Apply the change. `digest serve` reads the config once, at start, so restart it. In Docker:
   `docker compose restart digest`. A host timer or a manual `pnpm digest run` starts a new
   process each time and needs no restart. In Docker, run other commands as
   `docker compose run --rm digest <command>`.

## Verify

- `pnpm digest fetch --source example-blog` ends with `ok` and exit code 0.
- `pnpm digest doctor` prints `✓ source example-blog: reachable and readable`.
- After the next run, `pnpm digest show <week> --part items` lists rows with `example-blog` in the
  `Source` column.

## Roll back

Delete the object from `sources` and restart as in step 4. Nothing else was changed. Items
already sent stay in the run records and in cross-week dedupe.

## Troubleshooting

| Symptom                                                   | Cause                                          | Fix                                                        |
| --------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------- |
| `lowercase letters, digits and dashes` at `sources[0].id` | The id has capitals, `_` or spaces             | Use only `a-z`, `0-9` and `-`                              |
| `source ids must be unique`                               | Two entries share an id                        | Rename one                                                 |
| `the URL must not contain a username or password`         | `user:pass@` in the URL                        | Remove it; secrets belong in `.env`                        |
| `Unknown source: ...` from `fetch`                        | The id is not in the config that was loaded    | Check the id and the `-c` path                             |
| `Source <id> is not a GitHub repository URL`              | A `github` URL with a path, query or `.git`    | Use exactly `https://github.com/<owner>/<repo>`            |
| `<id> redirected to <host>, which is not its own host`    | The feed redirects to another host             | Use the final URL as `url`; only the same host is followed |
| A new feed never shows in the digest                      | Its items are old, low relevance or duplicates | `pnpm digest show <week> --part scores`                    |

## Related

- [Sources](../../configuration/sources.md) and [Collection limits](../../configuration/collection-limits.md)
- [Config keys](../../reference/config-keys.md)
- [src/sources/CLAUDE.md](../../../src/sources/CLAUDE.md)
- Redirects: a feed may redirect only to its own host (`www.` counts as the same host); a GitHub
  source may also reach `api.github.com`. The `sources` list is the whole network allowlist.
- Duplicates: when two sources return the same URL, the earlier source in the list wins.
- Evals: a source you add needs nothing in `evals/`. Only a new default source needs a recording
  ([evals/CLAUDE.md](../../../evals/CLAUDE.md)).
