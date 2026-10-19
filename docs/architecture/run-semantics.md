# Run semantics

Part of [Architecture](README.md).

The rules for what counts as "a run", when a run may start, and how it ends.

## Week id

A run belongs to an ISO week, for example `2026-W43`. The week is read in `schedule.timeZone`.
The run record and the digest files are named by the week id, and the run folder by the Monday of
that week (`dist/2026-10-19/digest/` for `2026-W43`), whatever day the run starts. `--since`
changes the collection window, not the week.

## One run at a time

- **Lock.** A run takes `dist/digest.lock` (inside `dataDir`) before it does anything. A holder
  rewrites the heartbeat every 60 seconds. A lock whose heartbeat is 5 minutes old, or whose
  process is gone on the same host, is taken over. Otherwise a second run fails with exit 1 and
  the message "Another run is in progress". See [lock](../operations/lock.md).
- The scheduler handles a held lock for you: it retries every 5 minutes for up to 2 hours.
  See [scheduler](../operations/scheduler.md).

## Idempotency, resume, force

- **Skip.** A week that already has a `sent` record ends `skipped` (exit 0) and sends nothing.
- **Resume.** A week that reached only some channels is not run again. `digest run` sends the
  saved `digest.md` to the missing channels and marks the week `sent`. No model is called. If
  `digest.md` is gone, or its links differ from what the other channels got, it refuses with a
  message that mentions `--force`. See [resume a partial delivery](../runbooks/recover/resume-partial-delivery.md).
- **Force.** `--force` runs the week from scratch, even if it was sent. See
  [force a week](../runbooks/run/force-a-week.md).
- **A better record is never replaced by a worse one.** A forced or dry run that reaches no
  channel keeps the old record and the old files of a sent week.

## Abort

`digest serve` stops a run when a 3 hour time limit passes or a second stop signal arrives. The
run ends `failed` and releases the lock. The signal reaches the feed fetches, the guards and every
model call, so a hanging call no longer holds the run until its timeout; the run stops within one
call and no new call or writer starts. A step that was running fails as
`Run aborted during the <step> step` and is not retried. Between the other steps the signal is
checked as before, and a delivery that has started finishes first.
See [stopping and restarts](../operations/stopping-and-restarts.md).

## Statuses and exit codes

| Status    | Meaning                                                  | Exit | Failure note                  |
| --------- | -------------------------------------------------------- | ---- | ----------------------------- |
| `sent`    | The winner reached every channel                         | 0    | no                            |
| `dry-run` | A winner was written to disk, nothing was sent           | 0    | no                            |
| `skipped` | The week already has a sent digest                       | 0    | no                            |
| `quiet`   | Nothing collected, or fewer than 3 items worth sending   | 3    | only if nothing was collected |
| `blocked` | Every draft was rejected and the fallback digest failed  | 2    | yes                           |
| `failed`  | A health check, a step or a delivery failed, or no draft | 1    | yes                           |

A failure note is a short plain-text message on every channel, plus `<week>.failed.md`. A dry
run sends none.

`blocked` is rare. When every writer draft is rejected by the checks or the output guards, the run
builds a fallback digest from the selected items' own text and sends it, so the status is `sent`
(or `dry-run`), the exit code is 0 and no failure note goes out. The record has `fallback: true`,
the winner is `fallback`, and the digest footer says it was written from the sources' own words.
`blocked` remains for a fallback that fails its own link or format check, and for tests and the
eval replay, which switch the fallback off. A write step where every writer produced no draft at
all still ends `failed`. See [digest run](../features/digest.md#fallback-digest).

In `serve`, a failed week is retried at most twice, 30 minutes apart, and sends one note, from its
last attempt. All exit codes: [exit codes](../reference/exit-codes.md).

## Delivery guarantees

- Delivery is at least once. A message can arrive twice when a server took it and then reported
  an error.
- A send is retried twice (after 5 and 10 seconds), only when nothing was sent: a connect
  failure, HTTP 429 or 5xx, or SMTP 421, 450 or 451. See [delivery retries](../operations/delivery-retries.md).
- Once any channel took the digest, its URLs count as sent for cross-week dedupe.

## Related

- [Data flow](data-flow.md), [data layout](data-layout.md)
- [Triage](../operations/triage.md), [digest feature](../features/digest.md)
