# Dry run

Part of [Runbooks](../README.md) / Run.

## Purpose

Run the whole pipeline (collect, guards, classify, process, write, select) and write the result to
disk, while sending nothing. Use it to see what a real run would produce.

## When to use

- After a config, source or model change, before the next real run.
- As the [first run](../set-up/first-run.md) of a new install.
- To look at a week that is already sent, use [Preview a week](preview-a-week.md) instead.

## Prerequisites

- A green `digest doctor`. A dry run still calls the models and takes the same time as a real one.
- No other run in progress: a dry run takes the run lock too.

## Steps

1. Run it. Docker: `docker compose run --rm digest run --dry-run`.

   ```bash
   pnpm digest run --dry-run
   ```

   Add `--out ./try` to write the digest files to another folder, or `--since 14d` for a wider
   window. `--seed <n>` changes the sampling.

2. Read the digest file named under `Markdown` in the summary.

What a dry run does and does not do:

| It writes                                                                                                                | It does not do                                         |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| `data/runs/<week>/`: `run.json` (status `dry-run`), `items.json`, `scores.json`, `drafts.json`, `digest.md`, `review.md` | Send email or Slack, or run the `deliver` step         |
| `<week>.md` and `<week>.html` in `delivery.markdown.dir` (or `--out`)                                                    | Send a failure note, even if the run fails             |
|                                                                                                                          | Count as `sent`: its links stay out of the dedupe list |

A week left at `dry-run` is unsettled. If `digest serve` starts later and the Monday slot has
passed, it runs the week for real.

If the week is already `sent`, a plain dry run ends `skipped`. With `--dry-run --force` it runs,
but it never replaces the sent record or the week's files, and it writes nothing to the digest
folder. The summary then says the week's run folder is unchanged.

## Verify

- Exit code 0, `Status    dry-run` and the line `Dry run: nothing was sent.`
- `pnpm digest history -n 1` shows the week as `dry-run`.
- The Markdown and HTML files exist. Your inbox and Slack channel got nothing.

## Roll back

Nothing was sent, so nothing needs undoing. Delete `dist/digests/<week>.*` (or your `--out`
folder) if you do not want the files. The next real run replaces the `dry-run` record.

## Troubleshooting

| Symptom                                                             | Cause                             | Fix                                                              |
| ------------------------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------- |
| `This week already has a sent digest. Use --force to run it again.` | The week is `sent`                | Use `--dry-run --force`, or [Preview a week](preview-a-week.md). |
| `Error: could not write the dry-run digest to <dir>: ...`           | The digest folder is not writable | Fix permissions or use `--out <dir>`. Exit is 1.                 |
| Exit 3, `quiet`                                                     | Fewer than 3 items qualified      | [Quiet week](../debug/quiet-week.md).                            |
| Exit 2, `blocked`                                                   | Every draft was rejected          | [Blocked run](../debug/blocked-run.md).                          |
| `Another run is in progress`                                        | The lock is held                  | [Stuck lock](../debug/stuck-lock.md).                            |

## Related

- [Run now](run-now.md), [Force a week](force-a-week.md), [Preview a week](preview-a-week.md)
- [Run semantics](../../architecture/run-semantics.md), [Files and paths](../../reference/files-and-paths.md)
- [src/cli/run](../../../src/cli/run/run.ts)
