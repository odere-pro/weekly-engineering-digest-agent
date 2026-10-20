# Schedule

Part of [Configuration](README.md).

The schedule tells `digest serve` (the Docker service) when to run the weekly digest. It also
fixes which time zone decides the ISO week id.

| Key                 | Type   | Default                                   | Limits    |
| ------------------- | ------ | ----------------------------------------- | --------- |
| `schedule.cron`     | string | `45 7 * * 1` (Mondays 07:45)              | not empty |
| `schedule.timeZone` | string | the time zone of the machine or container | not empty |

```json
{
  "schedule": { "cron": "45 7 * * 1", "timeZone": "Europe/Berlin" }
}
```

## Rules

- `cron` is a five-field cron expression (minute, hour, day of month, month, weekday), read by the
  `croner` library. `30 6 * * 2` runs on Tuesdays at 06:30. Pick one weekly slot: a week that
  already has a `sent` digest is skipped at later ticks.
- `timeZone` is an IANA name such as `Europe/Berlin`. The default is the zone of the process
  that loads the file. A container runs on UTC unless `TZ` is set in `.env` or the shell. That is
  why `digest init` asks for the zone and writes it.
- The config check only needs both to be non-empty. `digest doctor` tests them the way `digest
serve` does and prints `✓ schedule: next run <time>`, or a `✗ schedule:` line with the same
  `Invalid schedule (cron "...", time zone "..."): <reason>` text and a `fix:` line. `digest
serve` tests them at start-up and stops with that text and exit code 1.
- The ISO week id comes from `timeZone` too, for `serve` and for `digest run`. A Monday run near
  midnight lands in the week of the local calendar, not UTC. The day folder of `digest fetch` and
  the day of a log file (`dist/logs/<day>/digest.log`) come from `timeZone` as well.

## What `serve` does with it

| Behaviour         | Detail                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------ |
| Weekly tick       | Runs the current week at each cron time, one run at a time                                             |
| Catch-up on start | If this week's first slot has passed and the week has no `sent`, `quiet` or `blocked` run, it runs now |
| Lock held         | Retries every 5 minutes, for up to 2 hours                                                             |
| A `failed` run    | Retried up to 2 more times, 30 minutes apart. One failure note per failed week                         |
| Time limit        | A run that takes longer than 3 hours is stopped after its current step                                 |

The log line `Scheduler started` shows the cron, the time zone and `nextRun`.
Changing the schedule needs a restart: `docker compose restart digest`
([when changes apply](config-file.md#when-a-change-takes-effect)).

## Without Docker

`serve` is optional. `digest init` prints a launchd, systemd or `schtasks` entry that runs
`digest run` weekly. Those entries accept only the shape `m h * * dow` (single minute and hour,
day of month and month as `*`). They fire in the machine's local time, not in `schedule.timeZone`.
Another cron shape gives an error that points you to run `digest run` from your own scheduler.

## Change it

- [Change the schedule and time zone](../runbooks/configure/change-the-schedule-and-time-zone.md)
- [Schedule weekly runs](../runbooks/set-up/schedule-weekly-runs.md)
- [Stuck lock](../runbooks/debug/stuck-lock.md)

## Related

- [Scheduler feature](../features/scheduler.md) and [operations: scheduler](../operations/scheduler.md)
- [Stopping and restarts](../operations/stopping-and-restarts.md)
- [Run semantics](../architecture/run-semantics.md)
- [src/scheduler/CLAUDE.md](../../src/scheduler/CLAUDE.md)
