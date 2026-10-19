# Force a week

Part of [Runbooks](../README.md) / Run.

## Purpose

Run a week again from scratch with `digest run --force`, even though it already has a sent digest.
Every channel then gets a new digest.

## When to use

- The sent digest was wrong and you want to replace it, and people should get a second one.
- A resume refused and its message mentions `--force`.
- Not for a week that only reached some channels: a plain `digest run` finishes those with no model
  call. See [Resume a partial delivery](../recover/resume-partial-delivery.md).
- Not for a week that failed before any channel got it: a plain `digest run` already starts over.
- To try a week without sending a second digest, use [Dry run](dry-run.md). More recovery
  options: [Re-run a week](../recover/re-run-a-week.md).

## Prerequisites

- You accept that email and Slack get another message. Delivery cannot be recalled.
- No run in progress (lock). A green `digest doctor`.
- Know the current state: `pnpm digest history -n 4`, then `pnpm digest show <week>`.

## Steps

How `--force` differs from the default:

| Situation                            | `digest run`                                     | `digest run --force`                     |
| ------------------------------------ | ------------------------------------------------ | ---------------------------------------- |
| Week is `sent`                       | Ends `skipped`, exit 0, nothing happens          | Runs the whole pipeline again            |
| Failed, some channels got the digest | Resumes: sends the saved `digest.md` to the rest | Ignores the resume and runs from scratch |
| Failed, no channel got it            | Runs from scratch                                | Same                                     |

`--force` does not skip the run lock, the guards, the link check or the format check. It does not
change the window or the week id.

1. Check the state and, if you want the old files, copy `dist/<monday>/` (the run folder and the source data). The run replaces each source's files
   as soon as it fetches them, even if it fails later.
2. Run the week.

   ```bash
   pnpm digest run --force
   ```

   Docker: `docker compose run --rm digest run --force`.

## Verify

- Exit code 0 and `Status    sent`; `pnpm digest history -n 1` shows `sent` with a new duration.
- `dist/<monday>/digest/` and `<week>.md` (in `delivery.markdown.dir`, or by default beside it)
  hold the new digest. The source data in `dist/<monday>/<source>/` is replaced too.
- If the forced run ends `failed`, `blocked` or `quiet`, the earlier sent record and files stay.
  The summary says the week's run folder is unchanged.

## Roll back

Messages already sent stay sent. If you copied the old run folder in step 1, restore it; the old
`digest.md` can be sent by hand. A forced run that does not reach a channel never replaces the sent
record, so there is nothing to undo.

## Troubleshooting

| Symptom                                          | Cause                                        | Fix                                                                          |
| ------------------------------------------------ | -------------------------------------------- | ---------------------------------------------------------------------------- |
| Message mentions `--force` and refuses to resume | `digest.md` is gone, or its links differ     | Run with `--force`, accepting a second digest on every channel.              |
| Exit 1, 2 or 3 after `--force`                   | The new run failed, was blocked or was quiet | The earlier sent digest still stands. Fix the cause, run again.              |
| `Another run is in progress`                     | The lock is held                             | [Stuck lock](../debug/stuck-lock.md).                                        |
| A different set of items than the first run      | The window moved on, feeds changed           | Expected. Use `--since` to widen the window.                                 |
| The scheduler runs the week again by itself      | `serve` retries failed weeks and catches up  | It never forces a sent week. See [Scheduler](../../operations/scheduler.md). |

## Related

- [Run now](run-now.md), [Re-run a week](../recover/re-run-a-week.md)
- [Run semantics](../../architecture/run-semantics.md), [Triage](../../operations/triage.md)
- [src/digest/CLAUDE.md](../../../src/digest/CLAUDE.md)
