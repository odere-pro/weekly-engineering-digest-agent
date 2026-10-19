# Store adapters (files)

## Intent

The file-based `RunStore`. It keeps one folder per ISO week and the single-run lock in a plain
data folder, so the tool stays local-first with no database. This folder holds the adapter
(`createFsRunStore`), the week folder helpers, the atomic file primitives and the run lock. The
lock is split into three subfeature folders, each with its own `CLAUDE.md`.

## How it works

1. `createFsRunStore({ dataDir, clock?, logger? })` (`fsRunStore.ts`) implements every `RunStore`
   method. Every run id goes through `assertRunId` first, because ids become folder names.
2. Artifacts go through `artifactFile` (`artifactFiles.ts`): one table of artifact names, one
   file each. A name outside the table throws `DigestError` before any path is built.
3. `acquireLock(runId)` calls `acquireRunLock` (`runLock.ts`), which sweeps old temp files, builds
   this process's lock, creates the lock file, and takes over an abandoned one.
4. Every write goes through `writeFileAtomic` or `createFileExclusive` (`atomicFile.ts`).

## The data folder

```
<dataDir>/
  digest.lock                 the run lock (JSON), present while a run holds it
  digest.lock.takeover        the takeover guard, present for milliseconds
  runs/<weekId>/
    run.json                  the RunRecord, written last
    items.json scores.json drafts.json digest.md review.md error.json     the artifacts
```

`prune` empties a week folder except `digest.md`. Temp files are `<name>.<pid>.<uuid>.tmp` in the
same folder as their target.

## Design

- Atomic writes: temp file, fsync, rename. A reader sees the old file or the new one, never half.
  `createFileExclusive` writes a temp file and hard-links it, so a new file appears complete or
  not at all. The lock needs a file system with hard links.
- Artifact names are single-sourced in `ARTIFACT_FILES`. `satisfies Record<ArtifactName, string>`
  fails typecheck when the table and the port type disagree; `artifactFiles.test.ts` checks the
  same at run time and that `digest.md` is the file `prune` keeps.
- A missing, corrupt or wrong-week `run.json` reads as `undefined` and logs a warning. Other file
  system errors propagate.
- `isLockHeldError` (`lockState/lockHeldError.ts`) is the one way to tell "another run holds the
  lock" from other failures. Match on it, never on the message text.

## Files

| File                         | Role                                                                                                                                                 |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fsRunStore.ts`              | `createFsRunStore`: all port methods on the folder layout                                                                                            |
| `artifactFiles.ts`           | `ARTIFACT_FILES` table and `artifactFile(name)`                                                                                                      |
| `runFolders.ts`              | `assertRunId`, `runDir`, `listWeekFolders`, `readRunRecord`, `pruneWeekFolder`                                                                       |
| `atomicFile.ts`              | `writeFileAtomic`, `createFileExclusive`, `readTextIfExists`, `removeStaleTempFiles`                                                                 |
| `runLock.ts`                 | `acquireRunLock`, `AcquireLockOptions`: the order of the lock steps and its limits                                                                   |
| `lockState/`                 | Is a lock live, stale or ours? See `lockState/CLAUDE.md`                                                                                             |
| `heartbeat/`                 | Keeping and releasing our lock. See `heartbeat/CLAUDE.md`                                                                                            |
| `takeover/`                  | Replacing a stale lock; sweeping temp files. See `takeover/CLAUDE.md`                                                                                |
| `lockContender.ts`           | Child process for the contention test; not app code                                                                                                  |
| `*.test.ts`                  | Tests next to the code they cover; `fsRunStore.lock.test.ts` runs the lock through the store, and `runFolders.ts` is covered by `fsRunStore.test.ts` |
| `runLock.contention.test.ts` | 4 real processes race for the lock over 40 rounds                                                                                                    |

## Depends on, used by

Depends on: `../RunStore` (port), `../runRecord`, `domain/schemas`, `shared` (`clock`, `errors`,
`isoWeek`, `telemetry`).
Used by: `app/container` (`createFsRunStore`), the `cli` commands that read history, and
`delivery/adapters/markdownFile` and `cli/preview` (`writeFileAtomic`).

## Change it safely

- Run `pnpm vitest run src/store`. The contention test starts real processes and takes longer.
- Do not write files with plain `writeFile`. Use `writeFileAtomic`.
- A new artifact: add the name to `ArtifactName` (`../RunStore.ts`, frozen: ask the coordinator)
  and one line to `ARTIFACT_FILES`. Typecheck points at whichever is missing.
- Subfeature folders import `atomicFile` and `lockState`; none of them imports `runLock.ts`.
