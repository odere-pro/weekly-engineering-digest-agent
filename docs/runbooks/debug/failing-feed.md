# Debug a failing feed

Part of [Runbooks](../README.md) / Debug.

## Purpose

Find out why one source fails or returns nothing, and fix the source or take it out. A failing
feed never stops a run: it is skipped and listed, and the other feeds still count.

## When to use

- A run summary or `pnpm digest show <week>` lists `Source failed:` lines.
- `pnpm digest doctor` prints `! source <id>`.
- A source you expect in the digest never shows up. A feed that works but is empty is also
  covered here.
- If every feed fails, the week ends `failed` at `collect` (exit 1), not [quiet](quiet-week.md),
  and the scheduler retries it. The cause is then usually the network of the machine or the
  container.

## Prerequisites

- A shell on the machine that runs the digest. In Docker, replace `pnpm digest` with
  `docker compose run --rm digest`, so you test from the same network as the real run.
- The `id` of the source, as written in `digest.config.json`.

## Steps

1. See the failure the run recorded. Failed sources are in `failedSources` of `run.json`.

   ```bash
   pnpm digest show 2026-W41
   ```

   ```text
   Source failed: openai-news: HTTP 404 fetching openai-news
   ```

   The run also kept what the source answered, in the folder of that week's Monday:
   `dist/2026-10-05/openai-news/raw/` for `2026-W41` (the bodies and `responses.json` with the url
   without its query, the status and the content type of each answer). A failed source has no `formatted/` folder.

2. Check every feed now. A source line is `!` when it fails, with a `fix:` line. This probe
   reads one day of one item, waits 10 seconds, and does not retry. `doctor` still exits 0
   for a failing feed.

   ```bash
   pnpm digest doctor
   ```

3. Fetch the one source, with no models and no lock. It prints a table and saves the raw
   answer.

   ```bash
   pnpm digest fetch --source openai-news --since 7d
   ```

   ```text
   Source       Status  HTTP  Items  Skipped  Time  Error
   openai-news  failed  404   0      -        0.4s  HTTP 404 fetching openai-news
   ```

   The files land in `dist/<day>/` (today): `<id>/raw/response-1.xml` (or `.json`, `.html`),
   `<id>/formatted/items.json` and `fetch-summary.json`. The command exits 1 when any source failed.

4. Match the error and fix it.

   | Error text                                                | Cause                                          | Fix                                                  |
   | --------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------- |
   | `HTTP 404` or `HTTP 410 fetching <id>`                    | The feed moved or was removed                  | [Update the source](../configure/update-a-source.md) |
   | `<id> redirected to <host>, which is not its own host`    | A run follows redirects on the same host only  | Put the final URL in the config                      |
   | `Redirect from https to http ... not followed`            | The feed downgrades to plain http              | Use another feed URL                                 |
   | `Timed out after 10000 ms`                                | Slow host; a run retries twice first           | Try again later; check the network                   |
   | `Cannot parse feed <id>: ...`                             | The answer is not RSS or Atom (open `raw/`)    | Use the real feed URL                                |
   | `The feed of <id> is larger than 5 MiB`                   | The feed is too big                            | Use a smaller feed                                   |
   | `GitHub rate limit hit fetching <id> (HTTP 403)` (or 429) | No token, or the token is used up; not retried | Set `GITHUB_TOKEN` in `.env`                         |

5. If the status is `ok` but `Items` is 0, the feed is readable and holds nothing in the
   window. A run logs this as `Source returned no usable items` (log only; it is not in
   `run.json`). Widen the window with `--since 14d`, or look at `Skipped`, the entries that
   could not become items. A GitHub source without a token uses the `releases.atom` feed,
   which lists about the latest ten releases. With `GITHUB_TOKEN` it uses the REST API
   (20 per page, no drafts or prereleases).
6. If the feed is gone for good, remove the source. There is no per-source switch to turn a
   source off: take it out of `sources`. See
   [Remove or disable a source](../configure/remove-or-disable-a-source.md).

## Verify

`pnpm digest fetch --source <id>` ends with `1 source: 1 ok, 0 failed, N items` and exits 0.
`pnpm digest doctor` shows `✓ source <id>: reachable and readable`.

## Roll back

`fetch` only writes `dist/<day>/<id>/` and `dist/<day>/fetch-summary.json`; delete them if you do
not need them. Undo a
config edit by restoring the old `sources` entry.

## Troubleshooting

| Symptom                                        | Cause                            | Fix                                              |
| ---------------------------------------------- | -------------------------------- | ------------------------------------------------ |
| `fetch` works, the run still lists the source  | `serve` runs with the old config | `docker compose restart digest`                  |
| Works on the laptop, fails in Docker           | DNS or proxy of the container    | Test with `docker compose run --rm digest fetch` |
| `Unknown source: <id>. Sources in the config:` | A typo in `--source`             | Use an id from the list in the message           |

## Related

- [Fetch sources only](../run/fetch-sources-only.md) and [Feeds](../../operations/feeds.md)
- [Sources](../../features/sources.md) and [Default sources](../../sources.md)
- [src/sources/CLAUDE.md](../../../src/sources/CLAUDE.md)
