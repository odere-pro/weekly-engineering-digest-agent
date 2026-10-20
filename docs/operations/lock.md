# Lock

Part of [Operations](README.md).

Only one run may use a data folder (`dist/` by default) at a time. The lock is the file
`dist/digest.lock`.

## How it works

- A run creates the lock before it reads or writes anything else. The file is created complete
  or not at all (a temp file and a hard link), and holds the process id, host, start time and a
  heartbeat.
- The holder rewrites the heartbeat every 60 seconds.
- A second run that finds the lock fails with exit 1: "Another run is in progress".
- The scheduler treats that message as a lock miss and retries every 5 minutes for up to 2 hours.

## When a lock is taken over

A new run takes over the lock by itself when any of these is true:

| Situation                                                    | Meaning                             |
| ------------------------------------------------------------ | ----------------------------------- |
| The heartbeat is 5 minutes old                               | The holder is gone or frozen        |
| The lock names this host and a process that no longer exists | The holder crashed                  |
| The lock has this process id but another token               | A container restarted (PID 1 again) |
| The file cannot be parsed                                    | It is damaged                       |
| An older lock with no heartbeat is 6 hours old               | It came from an older version       |

Takeovers go through a guard file (`digest.lock.takeover`, abandoned after 30 seconds), so two
contenders cannot both remove the stale lock. Acquire tries 3 times, then fails.

## What you do

- **A run is going:** wait.
- **No run is going:** do nothing. The next run takes over a stale lock.
- **It still refuses:** stop everything that uses this data folder and delete the file. See
  [stuck lock](../runbooks/debug/stuck-lock.md).
- **A run hangs but stays alive** keeps its lock. In Docker, `docker compose kill digest` ends it at
  once (`restart` and `stop` wait up to 90 minutes), then `docker compose up -d` starts it again.

## Limits

- A run suspended for more than 5 minutes (a sleeping laptop) can lose its lock to another run. It
  does not stop when it wakes. Before it sends, it reads the week's record: if the other run
  delivered the week meanwhile, it fails with `Run aborted before the deliver step: another run
delivered ...`, sends no digest, and leaves the other run's record in place. A run that wakes
  after that check has passed can still send a second copy.
- The lock is plain files, with no operating-system lock. It needs a file system with hard
  links. Do not share the data folder between machines.
- `release()` never removes a lock that another run took over.

## Related

- [Store feature](../features/store.md), [run semantics](../architecture/run-semantics.md)
- [Scheduler](scheduler.md)
