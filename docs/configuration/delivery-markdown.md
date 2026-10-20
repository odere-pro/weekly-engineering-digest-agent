# Markdown delivery

Part of [Configuration](README.md).

The Markdown channel writes the digest to a folder on disk. It is always on and has no switch.
Email and Slack are extra channels on top of it.

| Key                     | Type   | Default | Limits    |
| ----------------------- | ------ | ------- | --------- |
| `delivery.markdown.dir` | string | none    | not empty |

With no `dir`, the files go to the week's digest folder in the data folder: week 2026-W42 is
`dist/2026-10-12/digest/2026-W42.md`, next to `run.json` and `digest.md`. Set `dir` to write every
week into one folder instead:

```json
{
  "delivery": { "markdown": { "dir": "dist/digests" } }
}
```

## What is written

| File               | When                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| `<week>.md`        | Every digest, for example `2026-W42.md`                                                                  |
| `<week>.html`      | The same digest as a page that opens in a browser                                                        |
| `<week>.failed.md` | A failure note: the step and the error, after a `failed` or `blocked` run. Removed once the week is sent |

Text from feeds and models is written without invisible characters (a bidi override, a zero-width
space, a tag character): each becomes a space, so a feed cannot reorder or hide what you read. The
same goes for the error in a `.failed.md`. A joiner between two emoji stays.

These names are the same with or without `dir`. Files are written atomically, and the old `.html` is removed first, so the two never come from
different runs. The folder is created when needed. A relative path is relative to the folder you
run `digest` from.

A **dry run** writes the same files and sends nothing else. A dry run sends no failure note, so
it writes no `.failed.md`.

Each run also keeps its winning digest at `<dataDir>/<monday>/digest/digest.md` (see
[files and paths](../reference/files-and-paths.md)). With no `dir` the channel's files sit in that
same folder, and [pruning](../operations/disk-and-pruning.md) keeps them when it empties an old
week. A `dir` outside the data folder is never pruned.

## Per run and in Docker

- `digest run --out <dir>` writes this run's files to another folder. The setting in the file
  does not change.
- In Docker the folder `./dist` on the host is mounted at `/app/dist`. With no `dir` the files
  reach `./dist/<monday>/digest/` on the host. A `dir` under `dist/`, such as `dist/digests`, works
  too. Any other path lives inside the container and is lost with it.
- `digest init` leaves this key out, so the files go to each week's digest folder.

`digest doctor` prints a `markdown` line with the full path, or an error when the folder cannot
be written. A missing folder is fine when its nearest parent is writable. With no `dir` the line
says "digests are written to each week's folder in" the data folder, which the `data dir` check
covers.

## Change it

- [Change the output folder](../runbooks/configure/change-the-output-folder.md)
- [Preview a week](../runbooks/run/preview-a-week.md) renders a saved run into the week's `digest/preview/` folder without sending

## Related

- [Delivery feature](../features/delivery.md)
- [Email](delivery-email.md) and [Slack](delivery-slack.md)
- [Failed delivery](../runbooks/debug/failed-delivery.md) and [delivery retries](../operations/delivery-retries.md)
- [src/delivery/CLAUDE.md](../../src/delivery/CLAUDE.md)
