# Scheduler

## Intent

Runs the digest every week without a person. `digest serve` (the Docker Compose service) keeps one
process alive and calls `startScheduler`, which fires `runDigest` on a cron, in a time zone, one
week at a time. It also covers what breaks a weekly job: a run missed while the machine was off,
a run lock held by a manual run, and a run that fails or hangs. For people who do not use `serve`,
`renderOsSchedule` writes a launchd, systemd or Task Scheduler entry that runs `digest run`.

## How it works

1. `cli/serve` calls `startScheduler(options)`. It builds a retry executor and a cron job
   (croner with `protect: true`; tests inject `cronFactory`).
2. Each tick calls the executor with `isoWeekId(clock.now(), timeZone)`. If a run is still going,
   the tick is logged as skipped.
3. Before it waits, `catchUp` finds the first cron slot inside the current ISO week. If that slot
   is past and `runStatus(weekId)` is not `sent`, `quiet` or `blocked`, the week runs now.
4. `attemptRun` calls `run(weekId, signal, { notifyFailure })` under a time limit. At the limit
   the signal aborts, so the run ends `failed` and frees its lock.
5. `runWithRetries` reads how the attempt ended. An error starting "Another run is in progress"
   is a lock miss: retry every 5 minutes for up to 2 hours (`lockRetry`). A result with status
   `failed` is retried as `failedRetry` says. A time-limit hit, a failure only `--force` can clear
   (`needsForce`) and any other thrown error are not retried.
6. With `onGiveUp` set, an attempt that will be retried is told `notifyFailure: false`. If the
   retry does not come (`stop()`, budget spent, lock never freed, retry threw), the scheduler
   calls `onGiveUp(weekId, lastResult)`. It sends the one note that was held back.
7. The `SchedulerHandle` has `nextRun()`, `stop()` (stops ticks, cancels a pending retry, lets a
   running digest finish) and `whenIdle()`.
8. `cli/init` calls `renderOsSchedule(os, { cron, command, workingDir })`. It parses the cron with
   `parseSimpleCron` and returns `{ path, content, installHint }` for `darwin` (launchd plist),
   `linux` (systemd service and timer) or `win32` (a `schtasks` line).

## Design

- One run at a time per process. Retries wait inside the same tick, so `whenIdle()` covers them.
- Defaults: lock retry every 5 minutes for 2 hours, run limit 3 hours (zero or less means none).
  `failedRetry` is off unless given; `digest serve` passes `DEFAULT_FAILED_RETRY` (2 more tries,
  30 minutes apart). A wait above 2^31-1 ms counts as off, because a timer would fire at once.
- A tick never throws. Failures are logged and the service stays up. A failing `onGiveUp` is logged.
- One failure note per failed week. A run that sends its own note at once (time limit, `--force`
  case, `RecordNotSavedError`) is never noted a second time.
- The week is read in `schedule.timeZone`. Catch-up searches from Monday 00:00 UTC minus 14 hours,
  so a zone as far ahead as UTC+14 still finds its Monday slot.
- The lock miss is found by the message text from `store/adapters/runLock.ts`. Keep both strings
  in step.
- OS schedules take only `m h * * dow`: one minute, one hour, day of month and month as `*`, and a
  weekday as `*`, number (0 and 7 are Sunday), name, list or range. Anything else gives a
  `DigestError` that points to running `digest run` from your own scheduler.
- OS schedules fire in the machine's local time zone, not `schedule.timeZone`. The hint says so.
- Output is escaped for its format: XML for launchd, doubled `%` and `$` for systemd, and for
  Windows a refusal of `"`, `&`, `|`, `<`, `>`, `^` and `%`. The command and folder must be one
  line, not empty, and not end with a backslash. The systemd timer sets `Persistent=true`.

## Files

| File            | Role                                                                                     |
| --------------- | ---------------------------------------------------------------------------------------- |
| `scheduler.ts`  | `startScheduler`, `DEFAULT_FAILED_RETRY`, `SchedulerOptions`, `SchedulerHandle`          |
| `simpleCron.ts` | `parseSimpleCron`: the `m h * * dow` subset the OS schedulers can express                |
| `osSchedule.ts` | `renderOsSchedule`: launchd, systemd and Task Scheduler text                             |
| `*.test.ts`     | `scheduler` (tick, handle), `.catchUp`, `.lockRetry`, `.notify`, `.giveUp`, `osSchedule` |
| `__fixtures__/` | None. Tests inject `cronFactory`, `fixedClock` and fake timers.                          |

## Depends on, used by

Depends on: `digest/runDigest` (the `RunResult` type), `digest/runEnding` (`isUnretriable`,
`needsForce`, `RecordNotSavedError`), `domain/schemas`, `shared` (`clock`, `errors`, `isoWeek`,
`telemetry`) and `croner`.
Used by: `cli/serve` (`startScheduler`, `DEFAULT_FAILED_RETRY`) and `cli/init` (`renderOsSchedule`).
Pipeline features must not import it.

## Change it safely

- Run `pnpm vitest run src/scheduler src/app/scheduler src/cli/serve test/integration/schedulerRestart`.
  Tests use `vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })` and
  `advanceTimersByTimeAsync`. Fire ticks by hand through an injected `cronFactory`.
- Read `scheduler.giveUp.test.ts` and `scheduler.notify.test.ts` before you touch the retry loop.
  The held-note rule is easy to break and a failed week must never end without one note.
- `stop()` must not abort a run in flight. `serve` does that itself on a second signal.
- Other folders change retries too: the `RunResult` shape, `isUnretriable` and `needsForce` in
  `digest/runEnding`, and the lock message in `store/adapters/runLock.ts`.
- `simpleCron.ts` has no test file of its own. `osSchedule.test.ts` covers it. A new cron shape
  needs all three renderers and tests for each.
