# Debug a failed run

Part of [Runbooks](../README.md) / Debug.

## Purpose

Find the step and the cause of a run that ended `failed` (exit code 1), fix it, and get the
week to `sent`.

## When to use

- `pnpm digest history` shows `failed`, `digest run` exited 1, or a note arrived with the title
  `Weekly digest <week> failed at <step>`.
- For other endings use the matching page: [blocked](blocked-run.md), [quiet](quiet-week.md),
  [lock held](stuck-lock.md), [one channel missed](failed-delivery.md).

## Prerequisites

- A shell on the machine that runs the digest. In Docker, replace `pnpm digest` with
  `docker compose run --rm digest`.
- Ollama running before you re-run.

## Steps

1. List the newest runs. The first `failed` row is the week to open.

   ```bash
   pnpm digest history -n 4
   ```

2. Read the week. The `Error:` line gives the message and the step. The last name on the
   `Timings:` line is the step that failed.

   ```bash
   pnpm digest show 2026-W41
   ```

3. For the stack and the time, open `data/runs/2026-W41/error.json` (it has `step`, `name`,
   `message`, `at` and `stack`). It is written only for a failure, and only when the run's
   record was saved.
4. Run the health check. Each problem has a `fix:` line.

   ```bash
   pnpm digest doctor
   ```

5. Match the message to a row, and apply the fix.

   | Message or step                                                                     | Cause and fix                                                                       |
   | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
   | `Ollama is not reachable: ... Start Ollama and run again.`                          | Start Ollama, or fix `OLLAMA_URL` (Docker on a Mac: `host.docker.internal`)         |
   | `Ollama is missing models for profile "light": <tags>.`                             | `ollama pull <tag>` for each tag listed                                             |
   | `Ollama generate call to <model> (role write) timed out ...`                        | [Slow model](slow-model-or-out-of-memory.md)                                        |
   | `Ollama decide call to <model> failed: ...`                                         | Model call failed after 2 retries. Read the Ollama log, run `doctor`                |
   | `Model output for <step> failed validation after one repair attempt`                | The model returned bad JSON twice. Run again; replace the model if it repeats       |
   | `classify: ...`                                                                     | A classifier answer was missing or out of range. Run again                          |
   | `Every writer failed: <tags>; drafts.json has the reasons`                          | `pnpm digest show <week> --part drafts` lists each writer's error under `Problems:` |
   | `Delivery failed on email (...); delivered on markdown`                             | [Failed delivery](failed-delivery.md)                                               |
   | `Run aborted before the <step> step: run timed out after 3 h`                       | The scheduler's 3 hour limit. Not retried. Run by hand                              |
   | `Run aborted before the <step> step: the service was asked to stop again (SIGTERM)` | Someone stopped the service twice. Run again                                        |
   | `Could not save the run record (...)`                                               | `dataDir` is not writable or the disk is full. Fix it, run again                    |
   | `Another run is in progress (pid ..., week ...)`                                    | [Stuck lock](stuck-lock.md). No record is saved for this                            |
   | `Invalid config in ...` or `Invalid --since "..."`                                  | Fix the field named in the message                                                  |

6. Run the week again. A failed week has no sent digest, so `--force` is not needed.

   ```bash
   pnpm digest run
   ```

   If some channel already got the digest, this resumes: it sends the saved digest to the
   missing channels only. See [Resume a partial delivery](../recover/resume-partial-delivery.md).

## Verify

`pnpm digest history -n 1` shows the week as `sent` (exit code 0), and `<week>.md` is in the
digest folder (`dist/digests`, in Docker `data/digests`).

## Roll back

Nothing to undo. A new run replaces a `failed` record. It never replaces a record that got
further: a `sent` week stays, and so does a partly delivered one.

## Troubleshooting

| Symptom                    | Cause                                                    | Fix                                          |
| -------------------------- | -------------------------------------------------------- | -------------------------------------------- |
| No `run.json` for the week | The run stopped before saving: lock held, invalid config | Read the message on the terminal or the logs |
| No `error.json`            | The earlier record stayed (`Kept the ... run record`)    | Read `run.json` and the log line             |
| Same error after the fix   | Docker `serve` still runs the old config                 | `docker compose restart digest`              |
| No failure note arrived    | A dry run sends none; the scheduler held it for a retry  | Wait for the retry (2 more, 30 min apart)    |

## Related

- [Triage](../../operations/triage.md) and [Exit codes](../../reference/exit-codes.md)
- [Read the logs](../observe/read-logs.md) and [Show a week](../observe/show-a-week.md)
- [src/digest/CLAUDE.md](../../../src/digest/CLAUDE.md)
