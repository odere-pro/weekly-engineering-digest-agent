# Stopping and restarts

Part of [Operations](README.md).

## Docker

`docker compose stop` waits up to 90 minutes (`stop_grace_period`) for a running digest to
finish. An idle container stops at once. A container that is killed anyway leaves a lock; the
next run takes it over once its heartbeat is 5 minutes old, including from another container.

## `digest serve` signals

| Signal                  | Effect                                                                  |
| ----------------------- | ----------------------------------------------------------------------- |
| First SIGINT or SIGTERM | Stops the scheduler; a running digest finishes                          |
| Second                  | Aborts the running digest after its current step; the run ends `failed` |
| Third                   | Ends the process                                                        |

`serve` exits 0 after a stop signal. If you stop it while a failed week waits for its retry, the
held failure note is sent at once and the next start catches the week up.
See [scheduler](scheduler.md).

## Restart after a change

`serve` builds the app once at start, so a change to `digest.config.json` or `.env` needs a
restart:

```bash
docker compose restart digest
```

## A run that hangs

The abort signal is checked between steps only. A hanging model call holds a run until its
timeout (per role, `models.timeoutsMs`). If a run stays alive but does nothing, kill the
container, because `stop` and `restart` wait out the grace period:

```bash
docker compose kill digest
docker compose up -d
```

See [slow model or out of memory](../runbooks/debug/slow-model-or-out-of-memory.md).

## Related

- [Lock](lock.md), [run semantics](../architecture/run-semantics.md)
