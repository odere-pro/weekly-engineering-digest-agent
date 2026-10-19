# Takeover

## Intent

Clears what a crashed run left behind. When the lock is stale, `takeOverStaleLock` replaces it
with ours. A guard file makes sure only one contender does that at a time. A sweep removes temp
files that a killed run never renamed.

## How it works

1. `takeOverStaleLock` (`takeover.ts`) first calls `acquireTakeoverGuard` (`takeoverGuard.ts`).
   The guard is `<lock>.takeover`, created like the lock.
2. If the guard exists, it is inspected as a `guard`. A live one throws the lock-held error. An
   abandoned one (30 s old, or its process is dead) is removed and the call returns `false`, so
   the caller tries again.
3. Under the guard it looks at the lock once more. A live lock throws. A stale one is removed
   (with a warning that names the reason and the previous holder), then ours is created.
4. The guard is removed in `finally`, but only if it is still ours.
5. `sweepOrphanedTempFiles` (`orphanSweep.ts`) runs before every acquire. It removes
   `digest.lock.<pid>.<uuid>.tmp` and the same for the guard, once 10 minutes old.

## Design

- Plain files give no OS lock, so two contenders could both see a stale lock and the second would
  delete the first one's fresh lock. The guard prevents that. Before each destructive step the
  guard is re-checked with `isOurs`, because another run may have broken it as abandoned.
- Returning `false` is not an error: `acquireRunLock` retries up to 3 times, then gives up with
  a plain `DigestError` that `isLockHeldError` does not match.
- The sweep never throws. A failed folder read, or a file that cannot be removed, is logged.
  Younger files are kept: their writer may still be running.
- Only files named exactly like the temp files of `atomicFile` are removed. Foreign files stay.

## Files

| File               | Role                                                  |
| ------------------ | ----------------------------------------------------- |
| `takeoverGuard.ts` | `GUARD_SUFFIX`, `guardPathOf`, `acquireTakeoverGuard` |
| `takeover.ts`      | `takeOverStaleLock`, `TakeoverOptions`                |
| `orphanSweep.ts`   | `sweepOrphanedTempFiles`, `OrphanSweepOptions`        |
| `*.test.ts`        | One per code file                                     |

## Depends on, used by

Depends on: `../lockState` (`inspect`, `createLockFile`, `isOurs`, `lockHeldError`,
`lockTimings`), `../atomicFile` (`removeStaleTempFiles`), `shared`. Used by: `../runLock.ts`.

## Change it safely

- `pnpm vitest run src/store/adapters/takeover src/store/adapters/runLock`. The real race is
  `runLock.contention.test.ts`: run it after any change here.
- Do not remove a re-check of the guard. Tests replace the guard at the exact clock reading
  where the check happens.
