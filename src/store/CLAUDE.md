# Store

> Keeps the run history (one record and a few files per ISO week) and the lock that allows one run
> at a time. Without it a week could run twice at once, be sent twice, or repeat last week's links.
> Port: `RunStore` (`RunStore.ts`). Adapter: `createFsRunStore` (`adapters/`), plain folders.
> `layout.ts` names every folder below the data folder (`dist/` by default).

## Context

```mermaid
flowchart LR
  runDigest["digest: runDigest, runEnding, runResume"] -.->|"lock, artifacts, RunRecord, sentUrls, prune"| port[[RunStore]]:::focus
  container["app/container"] -.->|"createFsRunStore, redactStore wraps it"| port
  cli["cli: show, history, feedback, preview"] -.->|"getRunRecord, listRuns, readArtifact"| port
  port --> fs["adapters/fsRunStore"]:::focus
  fs -.->|"weekDigestDir, weekOfDay"| layout["layout.ts"]:::focus
  fs --> disk[("dataDir: digest.lock, monday/digest/")]
  others2["delivery, sources/archive, observability, cli, config"] -.->|"paths, day, reserved id"| layout
  port --> others["evals: createEvalStore. test/fakes: MemoryRunStore"]
  classDef focus stroke-width:3px
```

## Flow

```mermaid
sequenceDiagram
  participant run as runDigest
  participant st as fsRunStore
  participant lock as digest.lock
  run->>st: hasSentDigest(week): sent, no force: skip, no lock taken
  run->>st: acquireLock(week)
  st->>lock: sweep old temp files, create it exclusively
  st--x run: if a live run holds it: DigestError "Another run is in progress"
  st->>lock: if it is abandoned: take over under the .takeover guard, warn
  st->>lock: every 60 s while held: heartbeat, only if the file is still ours
  run->>st: getRunRecord again (a run that held the lock may have just sent), sentUrls
  run->>st: saveArtifact per stage, saveRunRecord, review.md, error.json, prune
  run->>st: lock.release(): stop the beat, remove the file if still ours
```

- A week lives in the folder of its Monday, `<dataDir>/<monday>/digest/` (2026-W43 is
  `dist/2026-10-19/digest/`), whatever day the run ran. A resume or `--force` finds the same folder.
- The chain saves `items.json`, `scores.json`, `drafts.json` and `digest.md` per stage. `endRun`
  saves `run.json`, then `review.md` and `error.json`, then prunes (best effort). A crash leaves
  files and no `run.json`.

## Rules

- Run ids are ISO week ids (`WEEK_ID_PATTERN`): they become the Monday folder name (`weekDay`), so
  the methods that take one refuse any other string, also a W53 its year does not have
  (`saveRunRecord` fails its schema first).
- One lock per data folder, not per week: `runId` only names the holder. A live holder fails the
  caller with `DigestError` "Another run is in progress" (exit 1). `release()` is safe to repeat and
  never removes a lock another run took over.
- `hasSentDigest` is true only for status `sent`. `sentUrls(week, n)` reads the `n` weeks before
  `week` and counts a record with status `sent` or a non-empty `deliveredTo`: a partly delivered
  week must not repeat its links.
- `prune(week, keepWeeks)` empties the weeks older than `week` outside the `keepWeeks` before it:
  it deletes that Monday's source folders and all of `digest/` except `digest.md` and the delivered
  `<week>.md`, `.html`, `.failed.md` (leftover `*.tmp` files go too). It deletes `run.json`, so a
  pruned week leaves `sentUrls`: config requires `keepWeeks >= dedupeWeeks` (`config/schema.ts`).
  `pruneOldDays` then removes, for every day before the Monday of the oldest kept week, the
  source folders of that day folder (a day with no `digest/`, an old `digest fetch` day, goes whole)
  and `logs/<day>/`.
- A missing `run.json` reads as `undefined`; so does a corrupt or wrong-week one, with a warning.
  Other filesystem errors propagate. A `run.json` that fails the schema reads as missing, so its
  week looks unsent: a new `RunRecord` field must be optional.
- `listRuns` counts a Monday folder only when it holds `digest/`; any other dated folder is not a
  week. A source with the id `digest` would share its day folder with `digest/`, so `config/schema`
  refuses that id (`isReservedSourceId`).
- Secrets are removed before data gets here (`redactStore`, `app/redacting.ts`): add no record
  field that could hold one.

## Files

| File           | Role                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `RunStore.ts`  | The port, `RunLock`, `ArtifactName`                                                                                                        |
| `runRecord.ts` | `RunRecordSchema`, `RunRecord`, `DraftOutcome`: what `run.json` holds                                                                      |
| `layout.ts`    | The dist/ layout: `weekDay`, `weekOfDay`, `weekDigestDir`, `sourceDir`, `logsDir`, `dayOf` (a formatter per zone), `LOCK_FILE`. Paths only |
| `adapters/`    | The file adapter: folders, atomic files, the lock. `adapters/CLAUDE.md`                                                                    |
| `*.test.ts`    | Next to the code; temp folders and fake clocks; no fixtures                                                                                |

## Gotchas

- `RunStore.ts` and `test/fakes/MemoryRunStore.ts` are frozen files. `fsRunStore.test.ts`
  ("contract parity with MemoryRunStore") runs the same cases on both: change port behaviour and
  the fake together.
- `RunRecord` embeds `DeliveryIdSchema` (delivery), `GuardCheckIdSchema` (guards) and
  `JudgeScoreSchema` (select). Removing a value from one makes old `run.json` files unreadable.
- The scheduler does not call `isLockHeldError`: `scheduler.ts:149` keeps its own copy of the
  text, and `MemoryRunStore` throws the same literal. Change `LOCK_HELD_MESSAGE` with both.
- `layout.ts` is the one place that knows the folder names; `config/schema`, `delivery/adapters/markdownFile`,
  `observability/dailyLogFile`, `sources/adapters/archive`, `cli/preview`, `cli/feedback` and
  `evals/feedbackToLabels` import it. Keep it free of file access.
- `delivery/adapters/markdownFile` and `cli/preview` import `writeFileAtomic`: keep its signature.
- Update `docs/operations/lock.md` and `docs/runbooks/debug/stuck-lock.md` with any lock rule.
