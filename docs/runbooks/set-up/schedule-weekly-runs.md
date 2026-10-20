# Schedule weekly runs

Part of [Runbooks](../README.md) / Set up.

## Purpose

Make the digest run every week without you. You pick one of two ways: the built-in scheduler
(`digest serve`) or a timer from your operating system that calls `digest run`.

## When to use

- After a [first run](first-run.md) worked as a dry run.
- To change the day, hour or time zone of an existing schedule, use
  [Change the schedule and time zone](../configure/change-the-schedule-and-time-zone.md).

## Prerequisites

- A green `digest doctor` and a successful dry run.
- Pick **one** way. If both run, the second one ends `skipped` because the week is already sent.

| Way              | Fires in                                 | Catches up a missed week       | Retries a failed week                   |
| ---------------- | ---------------------------------------- | ------------------------------ | --------------------------------------- |
| `digest serve`   | `schedule.timeZone` (default Mon 07:45)  | Yes, at start                  | Twice, 30 minutes apart; lock held: 2 h |
| OS timer (`run`) | the machine's local time, not `timeZone` | systemd `Persistent=true` only | No                                      |

## Steps

### A. The built-in scheduler

1. Docker: start the service. It restarts with Docker (`restart: unless-stopped`).

   ```bash
   docker compose up -d
   ```

   On a Mac use `make docker-up`. On Linux use `docker compose --profile linux up -d`.

2. Node: keep the process alive yourself, in a terminal or under your own process manager.

   ```bash
   pnpm digest serve
   ```

`serve` reads the config once, at start. After any config change restart it. On start it runs the
current week at once if the Monday slot has passed and the week is not `sent`, `quiet` or `blocked`.

### B. An OS timer

1. `digest init` printed a snippet and a save path. If you no longer have it, write the file by
   hand from the examples below. The command inside must use absolute paths. Run through
   `pnpm digest init`, the snippet runs `<node> <clone>/dist/artifacts/cli.js run`. That file only
   exists after `pnpm build`: if it is missing, `init` prints a warning above the snippet. Run
   `pnpm build` before you install the timer.
2. macOS: save the plist as `~/Library/LaunchAgents/dev.eng-digest.weekly.plist`, then:

   ```bash
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.eng-digest.weekly.plist
   ```

3. Linux: save the service and the timer under `~/.config/systemd/user/` (excerpt below, `init`
   prints the full text), then:

   ```bash
   systemctl --user daemon-reload && systemctl --user enable --now dev.eng-digest.weekly.timer
   ```

   ```ini
   # dev.eng-digest.weekly.service
   [Service]
   Type=oneshot
   WorkingDirectory=/abs/path/to/clone
   ExecStart=/usr/bin/node /abs/path/to/clone/dist/artifacts/cli.js run
   # dev.eng-digest.weekly.timer
   [Timer]
   OnCalendar=Mon *-*-* 07:45:00
   Persistent=true
   [Install]
   WantedBy=timers.target
   ```

4. Windows: paste the `schtasks /Create /TN "dev.eng-digest.weekly" ...` line that `init` printed
   into Command Prompt (not PowerShell).

The unit and the task run from the clone folder, so `digest.config.json` and `.env` are found.
The snippet takes only a cron of the form `m h * * dow`. Anything else needs your own scheduler.

## Verify

- `serve`: `docker compose logs digest` shows a line `Scheduler started` with `cron`,
  `timeZone` and `nextRun`. Check that `nextRun` is the Monday and hour you expect.
- OS timer: `systemctl --user list-timers` (Linux), `schtasks /Query /TN "dev.eng-digest.weekly"`
  (Windows), or `launchctl print gui/$(id -u)/dev.eng-digest.weekly` (macOS) shows the job.
- After the first Monday: `pnpm digest history -n 1` shows the week as `sent`.

## Roll back

- `serve`: `docker compose down`, or stop the process (a running digest finishes first).
- Linux: `systemctl --user disable --now dev.eng-digest.weekly.timer`, then delete both files.
- macOS: `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/dev.eng-digest.weekly.plist`,
  then delete the plist.
- Windows: `schtasks /Delete /TN "dev.eng-digest.weekly" /F`.

## Troubleshooting

| Symptom                                                  | Cause                                                                                         | Fix                                                            |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| The job ran at the wrong hour                            | OS timers use local time; a container uses UTC                                                | Match the zone, or set `schedule.timeZone` for `serve`.        |
| `digest: command not found` in the job log               | A hand-written unit says plain `digest`                                                       | Use the absolute `node .../dist/artifacts/cli.js run` command. |
| The job fails with `Cannot find module .../cli.js`       | The snippet was installed before `pnpm build`                                                 | Run `pnpm build` in the clone, then start the job again.       |
| `No OS schedule snippet is available`                    | Platform not supported, the cron is not `m h * * dow`, or the command is not an absolute path | Use `serve`, or call `digest run` from your own scheduler.     |
| The Windows snippet is refused (quote or `& \| < > ^ %`) | `cmd.exe` would act on those characters                                                       | Use a path without them, or point at a wrapper script.         |
| Nothing ran while the machine was off                    | An OS timer has no catch-up (except systemd)                                                  | Run `pnpm digest run` by hand, or use `serve`.                 |

## Related

- [Scheduler](../../operations/scheduler.md), [Stopping and restarts](../../operations/stopping-and-restarts.md)
- [Run now](../run/run-now.md), [Failed run](../debug/failed-run.md)
- [src/scheduler/CLAUDE.md](../../../src/scheduler/CLAUDE.md)
