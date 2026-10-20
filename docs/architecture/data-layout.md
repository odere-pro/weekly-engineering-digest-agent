# Data layout

Part of [Architecture](README.md).

Everything a run leaves is plain files, so you can read it with a text editor. No database.

```text
dist/                                     dataDir (default "dist")
  artifacts/cli.js, cli.js.map            `pnpm build` output
  digest.lock                             the run lock (only while a run is going)
  logs/<day>/digest.log                   every log line as JSON, one file per day
  <monday>/digest/                        a week's run, for example 2026-10-19/digest/ for 2026-W43
    run.json                              status, timings, models, counts, failed sources, drafts, deliveredTo
    items.json                            collected items
    scores.json                           classifications of the items that passed the input guards
    drafts.json                           drafts, failed writers, rejections with problems
    digest.md                             the winning digest (kept after pruning)
    review.md                             tick sheet for `digest feedback`
    error.json                            only beside a failed record: step, message, time
    <week>.md, <week>.html                the Markdown channel (default; kept after pruning)
    <week>.failed.md                      the failure note (default; kept after pruning)
    preview/                              `digest preview` output (default)
  <monday>/<sourceId>/raw/                every answer the source gave during the run
    response-<n>.<xml|json|html>          one body per answer
    responses.json                        url (no query, no fragment), status, contentType per answer
  <monday>/<sourceId>/formatted/items.json  the items that source's fetch returned
  <day>/<sourceId>/raw|formatted          `digest fetch` output for the day it runs
  <day>/fetch-summary.json                `digest fetch` summary
  feedback/<week>.json                    written by `digest feedback`
  eval/checkpoints/                       `digest eval --resume` checkpoints
evals/scorecards/                         one scorecard per `digest eval` run
```

`<monday>` is the Monday of the run's ISO week: 2026-W43 is `2026-10-19`, whatever day the run
actually ran, so a resume or `--force` finds the same folder. `<day>` is the date in
`schedule.timeZone`. The paths come from one file, `src/store/layout.ts`. A source cannot have the
id `digest`, because its folder would share the day folder with `digest/`.

## Rules

- **Atomic writes.** Every file is written to a temp file, flushed and renamed, so a reader never
  sees half a file. A corrupt or wrong-week `run.json` reads as missing and logs a warning.
- **Pruning.** At the end of each run, weeks older than `keepWeeks` (12) are emptied: that
  Monday's source folders go, and so does everything in `digest/` except `digest.md` and the
  delivered `<week>.md`, `<week>.html` and `<week>.failed.md`. The `digest fetch` folders and the
  logs of every day before the oldest kept week go too. `keepWeeks` must be at least `dedupeWeeks` (4), because pruned
  weeks drop out of the cross-week dedupe. See [disk and pruning](../operations/disk-and-pruning.md).
- **Only weeks that reached a channel count for dedupe:** status `sent`, or a failed run with a
  non-empty `deliveredTo`.
- **No secrets, no prompt text.** Records and artifacts are redacted again just before they are
  saved. See [safety](safety.md).
- **Source data is evidence, not state.** A run saves what each source answered, with secrets
  taken out. A failed save is a warning and never fails a source, and nothing is saved outside a
  run. When a source is fetched twice on one day (a retry, or two `digest fetch` calls), the files of
  the last fetch stay. A `digest fetch` on a Monday writes into the same source folders as the run
  of that week.
- **Local disk with hard links.** The lock needs a file system with hard links (not FAT, exFAT
  or some SMB shares). Two machines must not share `dist/`.

## Reading a run

| You want                                           | Command or file                         |
| -------------------------------------------------- | --------------------------------------- |
| A summary of a week                                | `pnpm digest show <week>`               |
| What was collected                                 | `pnpm digest show <week> --part items`  |
| Which items were scored, and which made the digest | `pnpm digest show <week> --part scores` |
| What each writer made                              | `pnpm digest show <week> --part drafts` |
| The raw record                                     | `dist/<monday>/digest/run.json`         |
| A failure                                          | `dist/<monday>/digest/error.json`       |
| What a source answered during the run              | `dist/<monday>/<source>/raw/`           |
| The log of a day                                   | `dist/logs/<day>/digest.log`            |

Field by field: [run record](../reference/run-record.md). All paths for Node and Docker:
[files and paths](../reference/files-and-paths.md).

## Related

- [Store feature](../features/store.md), [run semantics](run-semantics.md)
- [Show a week](../runbooks/observe/show-a-week.md)
