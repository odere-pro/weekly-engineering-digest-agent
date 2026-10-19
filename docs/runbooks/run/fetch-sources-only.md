# Fetch sources only

Part of [Runbooks](../README.md) / Run.

## Purpose

Fetch the configured feeds the way a run does, with no models, and save the raw responses and the
parsed items. You see exactly what each source returned.

## When to use

- A feed fails, returns nothing or returns the wrong items, and you want to see why.
- You added or changed a source and want to check it before a run.
- For a quick yes or no per feed, `digest doctor` has one `source` line per feed. To judge the
  whole pipeline, use a [dry run](dry-run.md).

## Prerequisites

- A config with `sources`. No Ollama and no lock are needed. The command writes into the data
  folder (`dataDir`, default `dist`), and creates it when it is missing.
- Network access to the feed hosts. A GitHub source uses the REST API when `GITHUB_TOKEN` is set,
  and the Atom feed otherwise.

## Steps

1. Fetch every source. Pass source ids to fetch only those, and `--since` to change the window
   (`1d` to `31d`, default `windowDays`). `--out` picks the data folder to write into (default
   `dataDir`, `dist`).

   ```bash
   pnpm digest fetch --source openai-news ollama-releases --since 14d
   ```

   Docker: the default folder, `/app/dist`, is mounted from `./dist`, so
   `docker compose run --rm digest fetch` leaves its files in `./dist` on the host. An `--out`
   outside `dist` stays inside the container.

2. Read the table. One line per source:

   ```text
   Source           Status  HTTP  Items  Skipped  Time   Error
   openai-news      ok      200   12     0        0.8s
   ollama-releases  failed  403   0      -        0.4s   GitHub rate limit hit fetching ollama-releases (HTTP 403)
   2 sources: 1 ok, 1 failed, 12 items
   ```

3. Open the saved folder named in the last line, `dist/<day>/` (today, in `schedule.timeZone`).
   For each source `<id>`:
   - `<id>/raw/response-1.xml` (or `.json`, `.html`) is the response body, one file per answer, and
     `<id>/raw/responses.json` lists each answer's url (without its query string and fragment,
     which may hold a secret), status and content type.
   - `<id>/formatted/items.json` holds the parsed items (there is none when the fetch failed).
   - `fetch-summary.json` has one entry per source with status, HTTP code, entries, skipped, error,
     the `raw` files and the `formatted` file.

Each source gets one attempt with a 10 second limit and no retries, up to 4 at a time. That is
what a source does the first time in a run, without the retries a run adds.

## Verify

- The exit code is 0 when every source is `ok`, and 1 when any failed or the options were bad.
- `fetch-summary.json` exists. It is written last, so a day folder that has one is complete.
- `<id>/formatted/items.json` has the items you expect, with `publishedAt` inside the window.

## Roll back

Only the folders of the fetched sources and the summary are written: `dist/<day>/<id>/` and
`dist/<day>/fetch-summary.json`. Delete them. A second fetch on the same day replaces them. The
`digest/` folder, the lock and the run history are untouched. On a Monday, `dist/<day>/<id>/` is
also where the week's run keeps its source data, so a fetch then replaces that.

## Troubleshooting

| Symptom                                                    | Cause                                            | Fix                                                                            |
| ---------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------ |
| `Unknown source: x. Sources in the config: ...`            | The id is not in `sources`                       | Use an id from the list in the message.                                        |
| `Invalid --since "x". Use a number of days from 1d to 31d` | Wrong format                                     | Use `7d`.                                                                      |
| `GitHub rate limit hit fetching <id> (HTTP 403)`           | No token, or the limit is used up                | Add `GITHUB_TOKEN` to `.env`: [Rotate secrets](../maintain/rotate-secrets.md). |
| `HTTP 404`, or a redirect to another host                  | The URL moved; a feed may not leave its own host | Fix the URL: [Update a source](../configure/update-a-source.md).               |
| Status `ok` but `Items` is 0                               | No entry inside the window                       | Try `--since 31d`; the feed may be quiet.                                      |

## Related

- [Failing feed](../debug/failing-feed.md), [Add a source](../configure/add-a-source.md)
- [Feeds](../../operations/feeds.md), [Sources](../../configuration/sources.md), [Default sources](../../sources.md)
- [src/sources/CLAUDE.md](../../../src/sources/CLAUDE.md)
