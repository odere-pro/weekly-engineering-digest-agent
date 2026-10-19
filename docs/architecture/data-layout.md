# Data layout

Part of [Architecture](README.md).

Everything a run leaves is plain files, so you can read it with a text editor. No database.

```text
data/                      dataDir (default "data")
  digest.lock              the run lock (only while a run is going)
  runs/<week>/             one folder per ISO week, for example 2026-W43
    run.json               status, timings, models, counts, failed sources, drafts, deliveredTo
    items.json             collected items
    scores.json            classifications of the items that passed the input guards
    drafts.json            drafts, failed writers, rejections with problems
    digest.md              the winning digest (kept after pruning)
    review.md              tick sheet for `digest feedback`
    error.json             only after a failure: step, message, time
  feedback/<week>.json     written by `digest feedback`
dist/digests/              <week>.md and <week>.html (Docker: data/digests)
dist/fetch/<timestamp>/    `digest fetch` output
dist/preview/<week>/       `digest preview` output
evals/scorecards/          one scorecard per `digest eval` run
```

## Rules

- **Atomic writes.** Every file is written to a temp file, flushed and renamed, so a reader never
  sees half a file. A corrupt or wrong-week `run.json` reads as missing and logs a warning.
- **Pruning.** At the end of each run, folders older than `keepWeeks` (12) are emptied except
  for `digest.md`. `keepWeeks` must be at least `dedupeWeeks` (4), because pruned weeks drop out
  of the cross-week dedupe. See [disk and pruning](../operations/disk-and-pruning.md).
- **Only weeks that reached a channel count for dedupe:** status `sent`, or a failed run with a
  non-empty `deliveredTo`.
- **No secrets, no prompt text.** Records and artifacts are redacted again just before they are
  saved. See [safety](safety.md).
- **Local disk with hard links.** The lock needs a file system with hard links (not FAT, exFAT
  or some SMB shares). Two machines must not share `data/`.

## Reading a run

| You want                                           | Command or file                         |
| -------------------------------------------------- | --------------------------------------- |
| A summary of a week                                | `pnpm digest show <week>`               |
| What was collected                                 | `pnpm digest show <week> --part items`  |
| Which items were scored, and which made the digest | `pnpm digest show <week> --part scores` |
| What each writer made                              | `pnpm digest show <week> --part drafts` |
| The raw record                                     | `data/runs/<week>/run.json`             |
| A failure                                          | `data/runs/<week>/error.json`           |

Field by field: [run record](../reference/run-record.md). All paths for Node and Docker:
[files and paths](../reference/files-and-paths.md).

## Related

- [Store feature](../features/store.md), [run semantics](run-semantics.md)
- [Show a week](../runbooks/observe/show-a-week.md)
