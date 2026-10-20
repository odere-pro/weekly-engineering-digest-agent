# Lock

Part of [Operations](README.md).

Only one run may use a data folder (`dist/` by default) at a time. The lock is the file
`dist/digest.lock`.

## How it works

- A run creates the lock before it reads or writes anything else. The file is created complete
  or not at all (a temp file and a hard link), and holds the process id, host, start time and a
  heartbeat.
- The holder rewrites the heartbeat every 60 seconds.
- A second run that finds the lock fails with exit 1: "Another run is in progress". A run that
  loses all 3 races for the lock file (another run is taking it at that moment) fails with exit 1:
  "Could not take the run lock: another run is starting".
- The scheduler treats both messages as a lock miss and retries every 5 minutes for up to 2 hours.
  When that time is spent, it sends one note: "The run for 2026-W43 did not start: another run held
  the run lock for the whole retry budget."

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

## When a run loses its lock

A run that was frozen for more than 5 minutes (a suspended process or VM, a sleeping laptop) can
find, when it wakes, that another run took its lock over. The lock is also lost when someone
deletes `digest.lock` while the run is alive. The run sees the loss at its next heartbeat, within
60 seconds, and logs `Run lock is no longer ours (taken over or removed); this run stops`. Then:

- It stops within one model call or fetch. Its error starts with `Run aborted`, names the step,
  and ends with `this run lost its lock (another run took it over, or the lock file was removed)`.
  The scheduler does not retry it.
- It writes nothing more to the week's folder. It saves no `run.json`, `review.md` or `error.json`
  and prunes nothing. `digest run` prints why:
  `Kept the week for the run that took over the lock; this run lost it`.
- It sends no digest. Its failure note still goes to every channel, so you learn about the stall.
- One exception: a run that already sent the digest to a channel before it saw the loss still
  saves its record. Without it the other run would not know that the week was sent, and would
  send it again.

A run also checks the week's record right before it sends, and a resume does the same. If another
run delivered the week meanwhile, it fails with
`Run aborted before the deliver step: another run delivered ...`. It sends no digest and leaves
that run's record in place. This also covers a takeover that the heartbeat has not seen yet.

## What you do

- **A run is going:** wait.
- **No run is going:** do nothing. The next run takes over a stale lock.
- **It still refuses:** stop everything that uses this data folder and delete the file. See
  [stuck lock](../runbooks/debug/stuck-lock.md).
- **A run hangs but stays alive** keeps its lock. In Docker, `docker compose kill digest` ends it at
  once (`restart` and `stop` wait up to 90 minutes), then `docker compose up -d` starts it again.

## Limits

- A run that lost its lock notices only at its next heartbeat. Until then, up to 60 seconds after
  it wakes, it may still write a file of the week. A run frozen in the middle of a send finishes
  that send when it wakes. If the run that took over has sent the week by then, the week goes out
  twice.
- The lock is plain files, with no operating-system lock. It needs a file system with hard
  links. Do not share the data folder between machines.
- `release()` never removes a lock that another run took over.

## Related

- [Store feature](../features/store.md), [run semantics](../architecture/run-semantics.md)
- [Scheduler](scheduler.md)
