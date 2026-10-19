# Debug a stuck lock

Part of [Runbooks](../README.md) / Debug.

## Purpose

Find out who holds the run lock, decide whether it is a live run or a dead one, and free the
lock safely. One run at a time may use a data folder.

## When to use

- A run stops at once with `Another run is in progress (pid 4321, host 1a2b3c, week 2026-W43)`
  and exit code 1. No run record and no failure note are written for this.
- The scheduler logs `Another run holds the lock; will retry`, or gave up with
  `Scheduled run gave up: another run kept the lock`.
- The week simply did not run, and the logs show the lock.

## Prerequisites

- A shell on the host, with read access to the data folder (`dataDir`, default `data/`).
- Permission to stop the digest process or container. Nothing else needs to change.

## Steps

1. Read the lock. It exists only while a run is going.

   ```bash
   cat data/digest.lock
   ```

   ```json
   {
     "pid": 4321,
     "runId": "2026-W43",
     "startedAt": "2026-10-19T07:45:03.000Z",
     "hostname": "1a2b3c",
     "heartbeatAt": "2026-10-19T08:12:03.000Z"
   }
   ```

   (The real file also holds a `token` and, on Linux, a `pidNamespace`.) The holder rewrites
   `heartbeatAt` every 60 seconds.

2. Compare `heartbeatAt` with the clock (`date -u`).
   - **Under 5 minutes old:** a run is alive. Wait for it, or follow it with
     [Follow one run](../observe/follow-one-run.md). Do not delete the lock.
   - **5 minutes or older:** the holder is gone. Do nothing: the next run takes the lock over
     and logs `Taking over stale run lock` with a `reason`. Run `pnpm digest run`.
3. A lock is also taken over at once when it names this host and a pid that is not running,
   when the file cannot be read, and, for a lock from an older version without a heartbeat,
   after 6 hours.
4. If the holder is alive but hung (fresh heartbeat, no `ollama call` lines for longer than the
   timeouts), stop it. A hung model call keeps the lock, because the heartbeat comes from the
   process, not from the run. In Docker use `docker compose kill digest` for a hung run
   (`docker compose stop digest` waits up to 90 minutes). With Node, stop the pid from the file.
   Then start again and wait up to 5 minutes for the old lock to go stale.
5. Last resort: delete the lock by hand. Do this only after you have stopped every process and
   container that uses this data folder, and confirmed with `ps` or `docker compose ps`.

   ```bash
   rm data/digest.lock
   ```

   Remove `data/digest.lock.takeover` too if it exists (a guard that is left behind goes
   stale after 30 seconds on its own).

6. Run the week.

   ```bash
   pnpm digest run
   ```

## Verify

The run starts, and `data/digest.lock` shows the new `runId` while it runs. After it ends the
file is gone. `pnpm digest history -n 1` shows the status of the week.

## Roll back

A lock cannot be restored, and there is nothing to restore. If you deleted the lock while a
run was alive, that run logs `Run lock is no longer ours (taken over or removed); its
heartbeat stops` and carries on. Stop one of the two runs yourself, or both may send.

## Troubleshooting

| Symptom                                                | Cause                                               | Fix                                             |
| ------------------------------------------------------ | --------------------------------------------------- | ----------------------------------------------- |
| `Could not take the run lock: another run is starting` | Two runs started at the same moment                 | Run again after a minute                        |
| `EPERM` or `ENOTSUP` when the lock is created          | The folder has no hard links (FAT, exFAT, some SMB) | Put `dataDir` on a local disk                   |
| The lock returns after you delete it                   | A second scheduler (host timer and `serve`)         | Keep one scheduler                              |
| The scheduler gave up and sent no note                 | A lock miss has no failed run to report             | Run by hand, or restart `serve` (it catches up) |
| A laptop slept longer than 5 minutes mid-run           | Its lock went stale and was taken over              | Check `history`; run the week again if needed   |

## Related

- [Lock](../../operations/lock.md) and [Scheduler](../../operations/scheduler.md)
- [Stopping and restarts](../../operations/stopping-and-restarts.md)
- [src/store/CLAUDE.md](../../../src/store/CLAUDE.md) and
  [src/scheduler/CLAUDE.md](../../../src/scheduler/CLAUDE.md)
