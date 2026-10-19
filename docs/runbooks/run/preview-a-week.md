# Preview a week

Part of [Runbooks](../README.md) / Run.

## Purpose

Render a saved run's winning draft the way each channel shows it (Markdown, email, Slack) into
files you can open. It sends nothing and calls no model.

## When to use

- You want to see how a digest looks as an email or a Slack message before it goes out, or after a
  layout change.
- You want the digest of an old week without hunting for a sent copy.
- To produce a new digest, use [Dry run](dry-run.md). `preview` only re-renders a saved one.

## Prerequisites

- The week has a saved run with a winner: `dist/<monday>/digest/run.json` and `drafts.json`
  (`dist/2026-10-12/digest/` for `2026-W42`). Weeks older than `keepWeeks` keep only `digest.md` and
  the delivered digest files, so they cannot be previewed.
- `-c <path>` goes before `preview` if your config is not `digest.config.json`.

## Steps

1. Find the week id (an ISO week such as `2026-W42`).

   ```bash
   pnpm digest history -n 4
   ```

2. Render it. `--channel` is `markdown`, `email`, `slack` or `all` (default). `--out` is the
   folder for the previews (default `preview/` in the week's digest folder; with `--out <dir>`
   the files go to `<dir>/<week>/`).

   ```bash
   pnpm digest preview 2026-W42
   ```

   The command prints one absolute path per file:

   ```text
   /path/to/clone/dist/2026-10-12/digest/preview/digest.md
   /path/to/clone/dist/2026-10-12/digest/preview/email.html
   /path/to/clone/dist/2026-10-12/digest/preview/email.txt
   /path/to/clone/dist/2026-10-12/digest/preview/slack.json
   ```

3. Open `email.html` in a browser, `email.txt` in an editor, and read `slack.json` (Block Kit
   JSON). Docker: `docker compose run --rm digest preview 2026-W42`; the files land in
   `./dist/2026-10-12/digest/preview/` on the host, because `./dist` is mounted.

The files are built from `drafts.json` with today's templates, so they can differ from what was
sent if the layout changed since. Secrets are removed and control characters stripped. For a week
sent as the fallback digest, the preview leaves out the footer line "Written from the sources' own
words.", because `preview` does not read the record's `fallback` flag. The sent message and
`digest.md` have the line.

## Verify

- Exit code 0 and the file paths printed.
- `slack.json` is valid JSON: `node -e "JSON.parse(require('fs').readFileSync('dist/2026-10-12/digest/preview/slack.json','utf8'))"`.
- `email.html` lists the same items as `pnpm digest show 2026-W42 --part digest`.

## Roll back

Nothing was sent or changed in the run folder. Delete the `preview/` folder of the week.

## Troubleshooting

| Symptom                                                  | Cause                                     | Fix                                                                                   |
| -------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------- |
| `"x" is not an ISO week id like 2026-W42`                | Wrong week format                         | Use `YYYY-Www`.                                                                       |
| `No saved run for 2026-W42`                              | No `run.json`, or the week was pruned     | Check `digest history`; see [Disk and pruning](../../operations/disk-and-pruning.md). |
| `Run 2026-W42 (quiet) has no winning draft to preview`   | The run ended without a winner            | Preview a week with status `sent` or `dry-run`.                                       |
| `Week 2026-W42 has no drafts.json`                       | The file was removed                      | Re-run the week; see [Re-run a week](../recover/re-run-a-week.md).                    |
| `Unknown channel "x"; use markdown, email, slack or all` | Misspelled `--channel`                    | Use one of the four names.                                                            |
| `drafts.json does not have the expected shape`           | The file was edited or is from an old run | Re-run the week.                                                                      |

## Related

- [Show a week](../observe/show-a-week.md), [Dry run](dry-run.md)
- [Set up email](../configure/set-up-email.md), [Set up Slack](../configure/set-up-slack.md)
- [Delivery feature](../../features/delivery.md)
