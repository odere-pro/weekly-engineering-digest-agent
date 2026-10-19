# Markdown delivery

Part of [Configuration](README.md).

The Markdown channel writes the digest to a folder on disk. It is always on and has no switch.
Email and Slack are extra channels on top of it.

| Key                     | Type   | Default        | Limits    |
| ----------------------- | ------ | -------------- | --------- |
| `delivery.markdown.dir` | string | `dist/digests` | not empty |

```json
{
  "delivery": { "markdown": { "dir": "data/digests" } }
}
```

## What is written

| File               | When                                                                      |
| ------------------ | ------------------------------------------------------------------------- |
| `<week>.md`        | Every digest, for example `2026-W42.md`                                   |
| `<week>.html`      | The same digest as a page that opens in a browser                         |
| `<week>.failed.md` | A failure note: the step and the error, after a `failed` or `blocked` run |

Files are written atomically, and the old `.html` is removed first, so the two never come from
different runs. The folder is created when needed. A relative path is relative to the folder you
run `digest` from.

A **dry run** writes the same files and sends nothing else. A dry run sends no failure note, so
it writes no `.failed.md`.

This channel is separate from the run folder. Each run also keeps its winning digest at
`<dataDir>/runs/<week>/digest.md` (see [files and paths](../reference/files-and-paths.md)).

## Per run and in Docker

- `digest run --out <dir>` writes this run's files to another folder. The setting in the file
  does not change.
- In Docker the folder `./data/digests` on the host is mounted at `/app/dist/digests`. The
  default `dist/digests` therefore ends up in `./data/digests`. `data/digests` is the same
  folder under `/app/data`, so it works too. Any other path lives inside the container and is
  lost with it.
- `digest init` leaves this key out, so the default applies: `dist/digests` on Node and
  `data/digests` on the host in Docker.

`digest doctor` prints a `markdown` line with the full path, or an error when the folder cannot
be written. A missing folder is fine when its nearest parent is writable.

## Change it

- [Change the output folder](../runbooks/configure/change-the-output-folder.md)
- [Preview a week](../runbooks/run/preview-a-week.md) renders a saved run into `dist/preview` without sending

## Related

- [Delivery feature](../features/delivery.md)
- [Email](delivery-email.md) and [Slack](delivery-slack.md)
- [Failed delivery](../runbooks/debug/failed-delivery.md) and [delivery retries](../operations/delivery-retries.md)
- [src/delivery/CLAUDE.md](../../src/delivery/CLAUDE.md)
