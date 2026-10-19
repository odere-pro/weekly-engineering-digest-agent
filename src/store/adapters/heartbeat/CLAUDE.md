# Heartbeat

## Intent

Keeps our lock alive while a run works, and releases it at the end. A lock from another
container cannot be checked by pid, so the holder rewrites `heartbeatAt` on a timer. A silent
holder is presumed dead after 5 minutes.

## How it works

1. `createLockHandle` (`lockHandle.ts`) starts the heartbeat and returns the `RunLock`.
2. `startHeartbeat` (`heartbeat.ts`) sets a timer (every 60 s by default). Each tick checks that
   the file is still ours (`isOurs`), then rewrites it with a fresh `heartbeatAt`.
3. If the file is gone or another run owns it, the heartbeat warns once and stops for good.
4. `release()` stops the timer, waits for a beat in flight, removes the file if it is still
   ours, and only then marks itself released.

## Design

- A beat never throws. A failed write is logged and the next tick tries again.
- A slow disk skips beats; ticks never queue. At most one beat is in flight.
- The timer is `unref`ed, so it never keeps the process alive.
- `release()` is safe to repeat. It leaves a lock that another run took over, and a failed
  removal can be retried because the handle is marked released only after it worked.
- The heartbeat follows the event loop, not the run's progress. A hung run in a live process keeps
  its lock. That limit is written in the doc comment of `acquireRunLock`.

## Files

| File                 | Role                                                           |
| -------------------- | -------------------------------------------------------------- |
| `heartbeat.ts`       | `startHeartbeat`, `Heartbeat`, `HeartbeatOptions`              |
| `lockHandle.ts`      | `createLockHandle`: the `RunLock` returned by `acquireRunLock` |
| `heartbeat.test.ts`  | Beats, skipped beats, stop, lost lock, failed beat             |
| `lockHandle.test.ts` | Release, repeat, retry, taken-over lock                        |

## Depends on, used by

Depends on: `../lockState` (`isOurs`, `lockTimings`), `../atomicFile` (`writeFileAtomic`),
`../../RunStore` (the `RunLock` type), `shared`. Used by: `../runLock.ts`.

## Change it safely

- `pnpm vitest run src/store/adapters/heartbeat`. Tests use a 15 ms interval and real files.
- `stop()` must await the beat in flight, or a late beat can bring a released lock file back.
- Keep the check-then-write order: a beat that skips `isOurs` could overwrite a takeover.
