# Run record

Part of [Reference](README.md).

Each run leaves a folder `<dataDir>/runs/<week>/` (default `data/runs/2026-W42/`). `run.json` is
the record: the one file that says how the week went. This page lists its fields, from
`RunRecordSchema` in `src/domain/schemas.ts`, and what the other files hold. The folder layout is in
[data layout](../architecture/data-layout.md).

## `run.json`

| Field            | Type                 | Meaning                                                                                                                                   |
| ---------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `runId`          | string               | The ISO week id, for example `2026-W42`                                                                                                   |
| `status`         | string               | `sent`, `dry-run`, `skipped`, `quiet`, `blocked` or `failed`                                                                              |
| `dryRun`         | boolean              | True when the run was started with `--dry-run`                                                                                            |
| `startedAt`      | ISO date with offset | When the run began                                                                                                                        |
| `finishedAt`     | ISO date with offset | When it ended                                                                                                                             |
| `profile`        | string               | The configured profile name. On a non-Apple machine the tags below differ                                                                 |
| `modelsByRole`   | map                  | Role to tag: `classify`, `guardPolicy`, `guardRisk`, `judge` (a tag or `null`), `write` (a list)                                          |
| `sampling`       | object, optional     | `seed` and `temperatureByRole` the model calls used. Absent in older records                                                              |
| `fallback`       | boolean, optional    | Reserved for a digest built from the items' own text. No code writes it yet                                                               |
| `timings`        | list                 | `{ step, ms }` for each step that ran. Steps: `collect`, `guardInput`, `classify`, `process`, `write`, `guardOutput`, `select`, `deliver` |
| `counts`         | object               | Item counts, see below                                                                                                                    |
| `failedSources`  | list                 | `{ sourceId, error }` for each feed that failed. The error is cut to 300 characters                                                       |
| `disabledGuards` | list                 | Guard check ids that did not run: `clefPolicy`, `graniteRisk`, `graniteGroundedness`, `clefRubric` (`ruleInjection` is reserved)          |
| `drafts`         | list                 | One outcome per writer, see below                                                                                                         |
| `winner`         | string or `null`     | The writer tag whose draft won. `null` when no draft won                                                                                  |
| `sentUrls`       | list of URLs         | URLs delivered in this run. They feed the cross-week dedupe                                                                               |
| `deliveredTo`    | list, optional       | Channels that took the digest: `markdown`, `email`, `slack`. A partly delivered `failed` week lists the ones that did                     |
| `error`          | object, optional     | `{ message, step }` when the run failed. `step` is optional                                                                               |

`counts`:

| Field             | Meaning                                                                              |
| ----------------- | ------------------------------------------------------------------------------------ |
| `collected`       | Items collected from all sources                                                     |
| `afterGuardInput` | Items left after the input guards                                                    |
| `classified`      | Items the classifier scored                                                          |
| `afterProcess`    | Items that survived the process filters, before the top-N cut. Older records omit it |
| `selected`        | Items sent to the writers (at most `topN`)                                           |
| `digestItems`     | Items in the winning digest, `0` when there is none                                  |

A `drafts` outcome is `{ writer, passed, rejectedBy, score? }`. `rejectedBy` lists the check or
guard ids that rejected the draft: `write` (the writer produced nothing), `linkCheck`,
`formatCheck`, `graniteGroundedness`, `clefRubric`. `score` is `{ writer, score, byCriterion }`,
with the mean from 1 to 5 and the four criteria, present only when the judge scored the draft.

```bash
pnpm digest show 2026-W42 --part run
```

## The other files

| File          | Written when                    | Holds                                                                                                                                                            |
| ------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `items.json`  | After `collect`                 | The collected items: `id`, `sourceId`, `kind`, `url`, `title`, `summary`, `publishedAt`. `[]` for a week with none                                               |
| `scores.json` | After `classify`                | One classification per item that passed the input guards: `itemId`, `relevance`, `area`, `areaConfidence`, `hype`, `minorRelease`. No drop reasons               |
| `drafts.json` | After `write`                   | `drafts` (each writer's digest), `failures` (`writer`, `error`, and `retry` for a failed retry) and `rejections` (`writer`, `attempt`, `rejectedBy`, `problems`) |
| `digest.md`   | After `select`                  | The winning digest as Markdown. It is the only file kept after pruning                                                                                           |
| `review.md`   | At the end, best effort         | A tick sheet of picked items and up to 20 candidates, for `digest feedback`                                                                                      |
| `error.json`  | At the end of a failed run only | `runId`, `step`, `name`, `message`, `at` and, when known, `stack`                                                                                                |

All files are pretty JSON (or Markdown) written atomically. Secrets are removed before anything
is saved. Feed and model text in `items.json`, `drafts.json` and `digest.md` is untrusted: read it,
do not run it. A run that did not get far leaves only the files for the steps it finished.
`skipped` saves no record.

## Related

- [Data layout](../architecture/data-layout.md) and [files and paths](files-and-paths.md)
- [Show a week](../runbooks/observe/show-a-week.md) and [view run history](../runbooks/observe/view-run-history.md)
- [Exit codes](exit-codes.md): what each status means
- [Store feature](../features/store.md) and [domain feature](../features/domain.md)
