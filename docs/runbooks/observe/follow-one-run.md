# Follow one run

Part of [Runbooks](../README.md) / Observe.

## Purpose

Watch a run while it works, see which step it is in, and tell a slow step from a stuck one.

## When to use

- A run has been going for a long time and you want to know where it is.
- You started `digest run` by hand, or the scheduler started one, and you want to follow it.
- The run is over and you want the story afterwards: use [Show a week](show-a-week.md) or
  [Read the logs](read-logs.md).

## Prerequisites

- The run writes to a terminal or to Docker logs you can reach.
- For the lock check in step 4, read access to the `data/` folder (`dataDir` in the config).

## Steps

1. Pick the stream. For a manual run the JSON lines already appear in your terminal. For the
   scheduler (the `serve` service) follow the container.

   ```bash
   docker compose logs -f digest
   ```

2. Show only the step lines. Each step logs `Step finished` with its time in `ms` when it ends.
   The order is `collect`, `guardInput`, `classify`, `process`, `write`, `guardOutput`,
   `select`, `deliver`. A dry run has no `deliver`.

   ```bash
   docker compose logs -f digest | grep --line-buffered '"msg":"Step finished"'
   ```

3. Read the wait inside the current step. A model call logs `ollama call` when it ends, so a
   quiet stretch is a call in flight. Expect these gaps:

   | Step          | What takes time                                  | Time limit per attempt            |
   | ------------- | ------------------------------------------------ | --------------------------------- |
   | `collect`     | Feeds, 4 at a time                               | 10 s per source, 2 retries        |
   | `guardInput`  | One call per item per model guard, one at a time | 60 s (`clefPolicy`), 120 s (risk) |
   | `classify`    | One `decide` call per item, one at a time        | 60 s                              |
   | `write`       | One long call per writer, one after another      | 600 s                             |
   | `guardOutput` | One call per draft per guard                     | 60 s and 120 s                    |
   | `select`      | One judge call per passing draft (only with 2+)  | 120 s                             |

   A model call that passes its time limit is retried twice, then the step fails. See
   [Slow model or out of memory](../debug/slow-model-or-out-of-memory.md).

4. Check that the run is alive from another terminal. The lock file names the run and the
   last heartbeat. The holder rewrites `heartbeatAt` every 60 seconds.

   ```bash
   cat data/digest.lock
   ```

5. When it ends, the last line is `Run finished` with `status`, `winner` and `counts`. Then read
   the result.

   ```bash
   pnpm digest history -n 1
   ```

## Verify

The newest row of `history` shows the week you followed, with its final status. The same week
no longer has a `data/digest.lock` (the lock is removed at the end of a run).

## Roll back

Following changes nothing. Do not press Ctrl+C to stop watching a `digest run` in your
terminal: that stops the run. Use `docker compose logs -f` (Ctrl+C there only stops the
viewer) or open a second terminal.

## Troubleshooting

| Symptom                                 | Cause                                       | Fix                                                   |
| --------------------------------------- | ------------------------------------------- | ----------------------------------------------------- |
| No output for minutes inside `write`    | One writer call can take up to 600 s        | Wait; see the limits in step 3                        |
| `heartbeatAt` is older than 5 minutes   | The holder is gone or frozen                | [Stuck lock](../debug/stuck-lock.md)                  |
| `ollama call failed, retrying` lines    | A timeout or a 5xx; calls retry twice       | [Slow model](../debug/slow-model-or-out-of-memory.md) |
| `Another run is in progress` on a start | Another run holds the lock                  | Wait for it, or [Stuck lock](../debug/stuck-lock.md)  |
| `Run aborted before the` ... `step`     | The 3 h limit or a second stop signal fired | [Failed run](../debug/failed-run.md)                  |

## Related

- [Read the logs](read-logs.md) and [View run history](view-run-history.md)
- [Run now](../run/run-now.md) and [Scheduler](../../operations/scheduler.md)
- [Run lifecycle](../../architecture/run-semantics.md)
