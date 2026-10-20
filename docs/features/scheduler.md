# Scheduler

Part of [Features](README.md).

## What it is for

This feature runs the digest every week without a person. `digest serve` (the Docker Compose
service) keeps one process alive that starts a run on a cron, in a time zone, one week at a time.
It also covers what breaks a weekly job: a run missed while the machine was off, a lock held by a
manual run, and a run that fails or hangs. For people who do not use `serve`, it writes a launchd,
systemd or Task Scheduler entry that runs `digest run`.

## Where it sits

It is a supporting layer above the pipeline: `digest serve` starts it and it calls the digest run.
See [feature folders](../architecture/feature-folders.md).

## What it does

- Fires a run on the cron in `schedule.cron` (default Mondays at 07:45) in `schedule.timeZone`.
  The week id is read in that time zone. If a run is still going when the next tick comes, the tick
  is logged as skipped.
- Catches up at start. If the first cron slot of the current ISO week has passed and the week's
  status is not `sent`, `quiet` or `blocked`, it runs the week now.
- Gives a run a time limit of 3 hours. At the limit the run is aborted after its current step, ends
  `failed` and frees its lock.
- Lock miss: when a manual run holds the lock, or another run is taking it right now, it retries
  every 5 minutes for up to 2 hours.
- Failed run: `digest serve` retries it up to 2 more times, 30 minutes apart. A run that throws
  before it saves a record (a store read that fails with `EIO`, say) is retried on the same
  budget. It does not retry a time-limit abort or a failure that only `--force` can clear.
- Sends one failure note per failed week. An attempt that will be retried holds its note back. If
  the retry never comes (a stop, the budget used up, the lock never freed), the held note is sent.
- Writes the note itself when the week has no run record to report: the run threw on every
  attempt, or another run held the lock for the whole 2 hours. The text names the week and an
  error code or class, never the error message. A stop sends no such note; the next start runs
  the week again.
- A tick never throws. Failures are logged and the service stays up.
- `stop()` stops new ticks and cancels a pending retry, but lets a running digest finish.
- OS schedules (`digest init` prints one when you are not on Docker): launchd on macOS, a systemd
  service and timer on Linux, a `schtasks` line on Windows. They accept only simple crons of the
  form `m h * * dow`. They fire in the machine's local time zone, not in `schedule.timeZone`.

## What you can configure

- `schedule.cron` (default `45 7 * * 1`) and `schedule.timeZone` (default: the machine's zone). See
  [schedule](../configuration/schedule.md) and
  [change the schedule and time zone](../runbooks/configure/change-the-schedule-and-time-zone.md).
- The retry budgets and the 3 hour limit are fixed in code.
- `digest serve` reads the config once at start. After a change, restart it. See
  [stopping and restarts](../operations/stopping-and-restarts.md).
- To set up weekly runs: [schedule weekly runs](../runbooks/set-up/schedule-weekly-runs.md). All
  keys: [config keys](../reference/config-keys.md).

## What can go wrong

- Nothing runs on Monday. Check that the service is up, and look for the log line "Scheduler
  started" with the cron and the next run. A cron that never fires logs a warning. See
  [scheduler operations](../operations/scheduler.md).
- A run is stuck behind the lock. See [stuck lock](../runbooks/debug/stuck-lock.md) and the
  [lock page](../operations/lock.md).
- A week keeps failing. Read the failure note and see [failed run](../runbooks/debug/failed-run.md).
- You stop the service while a digest runs: the stop waits for it. A second stop aborts the run
  after its current step. See [stopping and restarts](../operations/stopping-and-restarts.md).
- An unsupported cron for an OS schedule gives an error that points to running `digest run` from
  your own scheduler.
- The service finds no retry for a failure that needs `--force`: see
  [force a week](../runbooks/run/force-a-week.md).

## Code and tests

- Folder: [src/scheduler/](../../src/scheduler/). Maintainer notes:
  [CLAUDE.md](../../src/scheduler/CLAUDE.md).
- No port. It uses the cron library croner, and tests inject a fake cron and a fixed clock.
- Tests sit next to the code and use fake timers. `scheduler.runDigest.test.ts` runs the scheduler
  on the real `runDigest` and run store.

## Related

- [cli](cli.md) starts it through `serve`. [digest](digest.md) is what it runs.
- [store](store.md) owns the lock it waits for.
- [Run semantics](../architecture/run-semantics.md) explains skip, resume and abort.
