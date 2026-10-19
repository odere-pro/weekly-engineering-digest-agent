# Store

## Intent

The digest runs once a week and must not run twice at the same time, send the same week twice, or
repeat last week's releases. The `RunStore` port keeps the run history (one record and a few files
per ISO week) and the single-run lock. The file adapter does this on a plain folder, so the whole
tool stays local-first with no database.

## How it works

1. `runDigest` calls `acquireLock(weekId)` first. A live run holding the lock makes it throw a
   `DigestError`; an abandoned lock is taken over with a warning.
2. Unless the run is forced, it skips the week when `hasSentDigest` is true. Later it reads
   `sentUrls(weekId, dedupeWeeks)`, the URLs to leave out of the new digest.
3. During the run it calls `saveArtifact` (`items.json`, `scores.json`, `drafts.json`, `digest.md`,
   `review.md`, `error.json`) and, at the end, `saveRunRecord(record)`.
4. At the end of the run it calls `prune(weekId, keepWeeks)` (best effort, a failure is only
   logged). `prune` empties old week folders but keeps their `digest.md`. `release()` on the lock
   handle removes the lock file.
5. `listRuns`, `getRunRecord` and `readArtifact` serve the `history`, `show`, `preview` and
   `feedback` commands.
6. `createFsRunStore({ dataDir, clock?, logger? })` is the adapter. It writes
   `<dataDir>/runs/<weekId>/...` and `<dataDir>/digest.lock`.

## Design

- Run ids become folder names, so `assertRunId` accepts only an ISO week id (`WEEK_ID_PATTERN`).
- Every write goes through `writeFileAtomic` (temp file, fsync, rename), so a reader never sees
  half a file. `saveRunRecord` validates with `RunRecordSchema` first.
- A missing, corrupt or wrong-week `run.json` reads as `undefined` and logs a warning. Other
  filesystem errors propagate.
- `sentUrls` counts the `weeks` weeks before the run, and only weeks that reached a channel:
  status `sent`, or a failed run with a non-empty `deliveredTo`.
- The lock is a file created with `createFileExclusive` (temp file plus hard link), so it appears
  complete or not at all. It records pid, host, PID namespace, a per-process token, start time and
  a heartbeat.
- The holder rewrites `heartbeatAt` every 60 s. A lock is abandoned when its heartbeat is 5 min
  old, when it names this host and a dead pid, when it has this pid with another token (PID 1 after
  a container restart), or when it cannot be parsed. A lock from older versions (no heartbeat) is
  abandoned after 6 h.
- Takeovers go through a guard file (`digest.lock.takeover`, abandoned after 30 s) so two
  contenders cannot both remove the stale lock. Acquire tries 3 times, then fails.
- Temp files left by a killed run next to the lock are swept once they are 10 min old.
- `release()` is safe to repeat and never removes a lock that another run took over.
- Known limits (plain files, no OS lock) are written in the doc comment of `acquireRunLock`; the
  operator view is in `docs/operations/lock.md`. The lock needs a filesystem with hard links.

## Files

| File                        | Role                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------ |
| `RunStore.ts`               | The port, `RunLock`, `ArtifactName`                                                  |
| `adapters/fsRunStore.ts`    | `createFsRunStore`: the folder layout and all port methods                           |
| `adapters/runLock.ts`       | `acquireRunLock`: lock file, heartbeat, takeover guard, limits                       |
| `adapters/runFolders.ts`    | Week folders: `assertRunId`, `runDir`, `readRunRecord`, `pruneWeekFolder`            |
| `adapters/atomicFile.ts`    | `writeFileAtomic`, `createFileExclusive`, `readTextIfExists`, `removeStaleTempFiles` |
| `adapters/lockContender.ts` | Child process for the contention test; not app code                                  |
| `adapters/*.test.ts`        | `fsRunStore`, `runLock`, `runLock.contention`, `atomicFile` tests                    |

## Depends on, used by

Depends on: `domain/schemas` (`RunRecordSchema`, `WEEK_ID_PATTERN`), `shared` (`clock`, `errors`,
`isoWeek`, `telemetry`).
Used by: `digest` (`runDigest`, `runEnding`), `app` (container, redacting), `cli` (`run`, `show`,
`history`, `feedback`, `preview`), `delivery/adapters/markdownFile` (`atomicFile`), `evals/runEval.ts`,
`test/fakes/MemoryRunStore.ts`, `test/integration/harness.ts`.

## Change it safely

- Run `pnpm vitest run src/store`. Tests use temp folders and fake clocks. `runLock.contention`
  starts 4 real processes for 40 rounds to race for the lock, so it takes longer than the rest.
- `fsRunStore.test.ts` has a parity block that runs the same cases on `test/fakes/MemoryRunStore`.
  If you change port behavior, change the fake too (a frozen file: ask the coordinator).
- A new artifact name goes in two places: the `ArtifactName` type and `ARTIFACT_NAMES` in
  `fsRunStore.ts`.
- Do not weaken the lock rules (token check, heartbeat, guard re-checks). Tests in `runLock.test.ts`
  and `fsRunStore.test.ts` cover each one.
- Do not write files with plain `writeFile`. Use `writeFileAtomic`.
- Secrets are removed before data gets here, by `app/redacting.ts`. Keep the store free of
  secret handling, but never add fields to a run record that could hold one.
