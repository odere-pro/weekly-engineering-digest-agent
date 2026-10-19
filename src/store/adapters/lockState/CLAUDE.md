# Lock state

## Intent

Answers one question about a lock file: is it live, stale or ours? It holds the lock file format,
the timings, the rules that make a lock stale, and the error for a held lock. Nothing here writes
a lock for long or runs a timer; the folders above it do that.

## How it works

1. `buildOwnLock` (`ownLock.ts`) describes this process: pid, run, host, PID namespace, a
   per-process token, start time and first heartbeat.
2. `createLockFile` (`lockFile.ts`) writes it with `createFileExclusive`. `parseLockFile` reads
   one back; `isOurs` compares the file on disk with ours (`sameLock`: pid, run, start, token).
3. `inspect` (`liveness.ts`) reads a path and returns `free`, `held` or `stale` with a reason.
   `staleReason` decides: the pid check first, then heartbeat age, then lock age.
4. `lockHeldError` builds the `DigestError` for a live holder. `isLockHeldError` recognises it.

## Design

- A pid only means something where it was written. The pid check runs only when the lock names
  this host and this PID namespace (or names neither, as legacy locks do).
- A lock with a heartbeat is judged by the heartbeat alone, in both directions: one a full
  timeout in the future is as stale as an old one. A guard ignores its heartbeat field and expires 30 s
  after it started. A legacy lock (no heartbeat) expires after 6 h.
- `LOCK_HELD_MESSAGE` is `Another run is in progress`. `isLockHeldError` is true for a
  `DigestError` that starts with it, whichever store threw it. Plain `Error`s do not match.
- `parseLockFile` returns `undefined` for anything unreadable; `inspect` calls that stale. Other
  read errors propagate.
- All timings live in `lockTimings.ts`. The beat interval times 3 stays under the timeout.

## Files

| File               | Role                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------- |
| `lockTimings.ts`   | The five `*_MS` constants                                                              |
| `lockFile.ts`      | Schema, `LockFile`, `OwnLock`, `parseLockFile`, `sameLock`, `createLockFile`, `isOurs` |
| `liveness.ts`      | `staleReason`, `inspect`, `LockState`, `LockKind`                                      |
| `ownLock.ts`       | `buildOwnLock`, `readPidNamespace`, the process token                                  |
| `lockHeldError.ts` | `LOCK_HELD_MESSAGE`, `lockHeldError`, `isLockHeldError`                                |
| `*.test.ts`        | One per code file                                                                      |

## Depends on, used by

Depends on: `../atomicFile`, `shared` (`clock`, `errors`).
Used by: `../heartbeat`, `../takeover`, `../runLock.ts`. `isLockHeldError` is also meant for
code outside the store, such as the scheduler.

## Change it safely

- `pnpm vitest run src/store/adapters/lockState`.
- Do not change a rule in `staleReason` without a test for both sides of its limit. The tests
  pin each limit to the second.
- Do not change `LOCK_HELD_MESSAGE`: `docs/runbooks/debug/stuck-lock.md` and callers that retry on a held lock
  depend on it.
- Adding a field to the lock file: make it optional in the schema, or older locks turn unreadable
  and get taken over.
