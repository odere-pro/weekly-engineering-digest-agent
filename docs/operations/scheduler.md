# Scheduler

Part of [Operations](README.md).

`digest serve` keeps one process alive and fires the digest on a cron, in a time zone, one week
at a time. In Docker it is the default command of the `digest` service.

## Schedule

`schedule.cron` (default `45 7 * * 1`, Mondays 07:45) in `schedule.timeZone` (default: the
machine's zone). The week id is read in that zone. The log line `Scheduler started` shows the
cron and `nextRun`. Change it: [change the schedule](../runbooks/configure/change-the-schedule-and-time-zone.md).

## Catch-up at start

When `serve` starts it finds the first cron slot of the current ISO week. If that slot has
passed, it runs the week now, unless the week already ended `sent`, `quiet` or `blocked`. A week
with no run, or whose last run `failed` or was a `dry-run`, runs.

## Retries

| Situation                              | What the scheduler does                         |
| -------------------------------------- | ----------------------------------------------- |
| The lock is held, or being taken       | Retry every 5 minutes for up to 2 hours         |
| The run ended `failed`                 | Retry at most twice, 30 minutes apart           |
| The run threw before it saved a record | Same two retries as a failed run, then one note |
| The run hit its 3 hour limit           | No retry                                        |
| A failure only `--force` can clear     | No retry (for example resume refused)           |
| The run could not save its record      | No retry (the run already sent its note)        |

"Being taken" is `Could not take the run lock: another run is starting`. A run that throws is
one where the store fails before the run has a record: a read of the run folder that fails with
`EIO` or `EACCES`, or a lock file on a file system without hard links (`EPERM`, `ENOTSUP`).

A week sends **one** failure note, from its last attempt. While a retry is pending the note is
held back. If you stop `serve` while a failed week waits for its retry, the held note is sent at
once and the next start runs the week again.

When a week ends with no run record to report, the scheduler writes the note itself, once:

- The run threw on every attempt:

  > The run for 2026-W43 stopped before it saved a record (EIO).

  It names an error code or class (`EIO`, `DigestError`), never the error message, which can hold
  paths. The message is in the log line `Scheduled run failed`.

- Another run held the lock for the whole 2 hours:

  > The run for 2026-W43 did not start: another run held the run lock for the whole retry budget.

  See [stuck lock](../runbooks/debug/stuck-lock.md).

If an earlier attempt of the week failed and held its note back, that note goes out instead, so
the week still gets one. A stop sends neither note: the next start runs the week again.

## Run limit

Each attempt runs under a 3 hour limit. At the limit the run is aborted after its current step,
ends `failed` and frees its lock.

## OS schedulers

If you do not use `serve`, `digest init` prints a launchd (macOS), systemd (Linux) or `schtasks`
(Windows) entry that runs `digest run`. It accepts only `m h * * dow` cron forms. These fire in
the machine's local time, not `schedule.timeZone`. A systemd timer sets `Persistent=true`, so a
missed run happens at the next boot. See
[schedule weekly runs](../runbooks/set-up/schedule-weekly-runs.md).

## Not running?

`docker compose ps` must show `digest` up. Start it with `docker compose up -d` (Linux: add
`--profile linux`). Config changes need a restart of `serve`:
`docker compose restart digest`.

## Related

- [Scheduler feature](../features/scheduler.md), [stopping and restarts](stopping-and-restarts.md)
- [Lock](lock.md)
