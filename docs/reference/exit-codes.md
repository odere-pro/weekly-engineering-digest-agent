# Exit codes

Part of [Reference](README.md).

Every `digest` command ends with an exit code. The codes are public: scripts and schedulers rely
on them, and they are not renumbered.

| Code | Name    | Meaning                                                                 |
| ---- | ------- | ----------------------------------------------------------------------- |
| 0    | ok      | A run that was `sent`, `dry-run` or `skipped`, or a command that worked |
| 1    | failed  | An error, a failed run, a held lock, a bad option or a bad config       |
| 2    | blocked | `run` only: every draft was rejected by the checks or guards            |
| 3    | quiet   | `run` only: nothing worth sending this week                             |

## Per command

| Command               | 0                                                   | 1                                                                     |
| --------------------- | --------------------------------------------------- | --------------------------------------------------------------------- |
| `init`                | Config and `.env` written                           | Cancelled, refused to overwrite with `--yes`, or a write failed       |
| `doctor`              | No `✗` lines (warnings are allowed)                 | At least one `✗`, or the config would not load                        |
| `doctor --readiness`  | At least one profile is `ready` or needs only pulls | No profile can run on this machine                                    |
| `run`                 | `sent`, `dry-run`, `skipped`                        | `failed`, or an error before the run                                  |
| `run` (also 2 and 3)  |                                                     | 2 is `blocked`, 3 is `quiet`                                          |
| `eval`                | Every hard gate passed                              | A hard gate failed, an unknown profile, or the judge is not installed |
| `fetch`               | Every source fetched                                | A source failed, an unknown source id, or a bad option                |
| `show`, `preview`     | Printed or written                                  | Bad week id, no saved run, missing file, unknown part or channel      |
| `history`, `feedback` | Done                                                | Config error, no review sheet, or a sheet that does not match         |
| `serve`               | Stopped by a stop signal                            | Start-up error, such as a bad config or `Invalid schedule`            |

A usage error (unknown command, unknown option, a missing `<week>`) also exits 1. An error that
no command expected is printed and exits 1.

A `dry-run` run whose digest file cannot be written to the output folder exits 1 and prints
`Error: could not write the dry-run digest to <dir>`.

## Run statuses

`run` saves a status in `run.json`. The status decides the exit code and whether a failure note
is sent to the channels.

| Status    | Meaning                                                  | Exit | Failure note                    |
| --------- | -------------------------------------------------------- | ---- | ------------------------------- |
| `sent`    | The winning digest reached every channel                 | 0    | no                              |
| `dry-run` | A winner was written to disk and nothing was sent        | 0    | no                              |
| `skipped` | The week already has a `sent` digest, so nothing ran     | 0    | no                              |
| `quiet`   | Nothing collected, or fewer than 3 items worth sending   | 3    | only when nothing was collected |
| `blocked` | Drafts were written and every one was rejected           | 2    | yes                             |
| `failed`  | A health check, a step or a delivery failed, or no draft | 1    | yes                             |

Notes on the table:

- A dry run never sends a failure note, whatever its status.
- A failure note is a short text on every channel. The Markdown channel also writes
  `<week>.failed.md`. A `failed` or `blocked` note names the step and the writer or check ids. It
  is built to carry no feed or model text.
- Under `serve`, a `failed` week is retried (two more tries, 30 minutes apart) and the scheduler sends
  one note for the week, from its last attempt.
- A week that reached only some channels ends `failed` with `deliveredTo` in `run.json`. The next
  `digest run` sends the saved digest to the missing channels only, and marks the week `sent`.
- `skipped` does not save a record: the earlier `sent` record stays as it was.

## In a script

```bash
pnpm digest run
case $? in
  0) echo "sent, dry-run or skipped" ;;
  2) echo "blocked: read digest show <week> --part drafts" ;;
  3) echo "quiet week" ;;
  *) echo "failed" ;;
esac
```

## What to do for each status

- `failed`: [failed run](../runbooks/debug/failed-run.md)
- `blocked`: [blocked run](../runbooks/debug/blocked-run.md)
- `quiet`: [quiet week](../runbooks/debug/quiet-week.md)
- `skipped`: [force a week](../runbooks/run/force-a-week.md)

## Related

- [CLI commands](cli-commands.md) and [run record](run-record.md)
- [Run semantics](../architecture/run-semantics.md)
- [src/domain/CLAUDE.md](../../src/domain/CLAUDE.md)
