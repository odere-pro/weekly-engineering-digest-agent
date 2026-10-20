# Change the schedule and time zone

Part of [Runbooks](../README.md) / [Configure](README.md).

## Purpose

Change the day and time `digest serve` runs the weekly digest, and the time zone it reads that
time (and the ISO week) in.

## When to use

- The digest should arrive on another day or hour.
- The container runs on UTC and the digest lands at the wrong local time.
- To set up a host timer for the first time, see [Schedule weekly runs](../set-up/schedule-weekly-runs.md).
- To run once now, use [Run now](../run/run-now.md).

## Prerequisites

- Write access to `digest.config.json`.
- A five-field cron time and an IANA zone name such as `Europe/Berlin`.

## Steps

1. Edit `digest.config.json`. The default is `45 7 * * 1` (Mondays at 07:45) in the zone of the
   process that read the config. In a container that zone is UTC unless `TZ` is set.

   ```json
   {
     "schedule": {
       "cron": "0 6 * * 5",
       "timeZone": "Europe/Berlin"
     }
   }
   ```

   `schedule.cron` reads minute, hour, day of month, month, weekday: `0 6 * * 5` is Fridays at
   06:00. `schedule.timeZone` is an IANA name. It also decides which ISO week a run belongs to,
   for `serve` and for a manual `pnpm digest run`.

2. Apply the change. `digest serve` reads the schedule once, at start, so restart it. In Docker:
   `docker compose restart digest`. The `TZ` variable only sets the container's own clock and
   log times; the schedule follows `schedule.timeZone`. In Docker, other commands are
   `docker compose run --rm digest <command>`.
3. Host timers (launchd, systemd, Task Scheduler) do not read `schedule.cron`. Edit the time in
   the file `digest init` printed for you and reload it as in
   [Schedule weekly runs](../set-up/schedule-weekly-runs.md). They fire in the machine's local
   time, not in `schedule.timeZone`. They need no restart of `serve`, since each tick starts
   `digest run`, which reads the config again.
4. Be ready for a catch-up. On start, `serve` runs the current week at once if this week's first
   slot has already passed and the week is not `sent`, `quiet` or `blocked`.

## Verify

- The log line `Scheduler started` is written at every start, with the cron, the zone and the
  next run in UTC. In Docker: `docker compose logs --tail 20 digest`.

  ```text
  {"level":"info","time":"2026-10-19T08:00:00.000Z","service":"eng-digest","cron":"0 6 * * 5","timeZone":"Europe/Berlin","nextRun":"2026-10-23T04:00:00.000Z","msg":"Scheduler started"}
  ```

- Convert `nextRun` to your zone: it must be the day and hour you wanted.
- `pnpm digest doctor` has a `schedule` line: `✓ schedule: next run <time>` (UTC), or a `✗` with
  the same `Invalid schedule` text that `serve` stops with at start, so a bad value is caught
  before a container crash-loops.

## Roll back

Put the old `cron` and `timeZone` back (or delete both keys for the defaults) and restart as in
step 2. An edited host timer file is changed back the same way.

## Troubleshooting

| Symptom                                                                                                        | Cause                                                                | Fix                                                      |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------- |
| `serve` exits with `Invalid schedule (cron "...", time zone "..."): CronPattern: invalid configuration format` | The cron text is not valid; the config check only needs it non-empty | Use five fields, for example `45 7 * * 1`                |
| `serve` exits with `Invalid schedule ...: Failed to convert date to timezone`                                  | The zone name is not an IANA name                                    | Use a name such as `Europe/Berlin`                       |
| Warning `The schedule has no upcoming run: check schedule.cron`                                                | The cron never fires, such as 31 February                            | Fix the day or month                                     |
| The digest comes at the wrong hour                                                                             | The zone is UTC (container default)                                  | Set `schedule.timeZone`                                  |
| A host timer still fires at the old time                                                                       | It keeps its own time                                                | Edit and reload the timer file                           |
| A run starts right after restart                                                                               | Catch-up for a week that had no result                               | Expected; see the `Catching up on a missed run` log line |

## Related

- [Schedule](../../configuration/schedule.md), [Scheduler](../../operations/scheduler.md)
- [Stopping and restarts](../../operations/stopping-and-restarts.md): a restart waits for a
  running digest to finish (up to 90 minutes in the Compose file).
- [Config keys](../../reference/config-keys.md), [src/scheduler/CLAUDE.md](../../../src/scheduler/CLAUDE.md)
