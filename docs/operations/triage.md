# Triage

Part of [Operations](README.md).

Start here after any run that did not end `sent`, and after a `sent` week whose digest says
"Written from the sources' own words." (a fallback digest).

## The first four steps

1. `pnpm digest history -n 4`. The newest row is the run to look at.
2. `pnpm digest show <week>` for a summary, or open `dist/<monday>/digest/run.json`. After a failure
   also open `error.json` in the same folder.
3. `pnpm digest doctor`. It prints a `fix:` line for each problem.
4. Logs are JSON on stdout (`docker compose logs digest` in Docker) and in
   `dist/logs/<day>/digest.log`. Filter by `runId` for one
   week and `step` for one step. `LOG_LEVEL=debug` adds detail.

Failed and blocked runs send a short failure note on every channel and write `<week>.failed.md`.
A dry run sends none. A fallback digest sends no note: it ends `sent` with exit 0, so the footer
line, `"fallback": true` in `run.json` and `Winner: fallback` in `digest history` are the only
signs.

## Status to action

| Status                        | Do this                                                                                                                          | Runbook                                         |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `failed`                      | Read the step in the note or `error.json`. Fix the cause, run again                                                              | [Failed run](../runbooks/debug/failed-run.md)   |
| `sent` with `fallback` winner | No model wrote this digest. Read `digest show <week> --part drafts`. Run again with `--force` if you want a model-written one    | [Blocked run](../runbooks/debug/blocked-run.md) |
| `blocked`                     | Rare: every draft was rejected and the fallback digest failed its own checks. Read `digest show <week> --part drafts`. Run again | [Blocked run](../runbooks/debug/blocked-run.md) |
| `quiet`                       | Often normal. Check `counts` in `run.json`                                                                                       | [Quiet week](../runbooks/debug/quiet-week.md)   |
| `skipped`                     | The week already has a sent digest. `digest run --force` sends again                                                             | [Force a week](../runbooks/run/force-a-week.md) |

## Failure causes, by step

| Message or step                                            | Cause                                                           | Runbook                                                                         |
| ---------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `Ollama is not reachable`, `missing models`                | Ollama is down, `OLLAMA_URL` is wrong, or a model is not pulled | [Failed run](../runbooks/debug/failed-run.md)                                   |
| `guardInput`, `classify`, `write`, `guardOutput`, `select` | A model call failed after its retries (timeout, memory)         | [Slow model or out of memory](../runbooks/debug/slow-model-or-out-of-memory.md) |
| `deliver`                                                  | At least one channel failed                                     | [Failed delivery](../runbooks/debug/failed-delivery.md)                         |
| `Another run is in progress`                               | The lock is held                                                | [Stuck lock](../runbooks/debug/stuck-lock.md)                                   |
| `Run aborted before the <step> step`                       | `serve` hit its 3 hour limit or got a second stop signal        | [Scheduler](scheduler.md)                                                       |
| Invalid config or `Invalid --since`                        | A field is wrong; the message names it                          | [Config file](../configuration/config-file.md)                                  |
| `Could not save the run record`                            | `dist/` is not writable or the disk is full                     | [Prune disk](../runbooks/maintain/prune-disk.md)                                |

## Check ids on a blocked or fallback run

A blocked run names each writer and the ids that rejected its draft. A fallback week keeps the same
ids in `run.json` and `digest show`, next to the `fallback` entry.

| Check id              | Meaning                                                            |
| --------------------- | ------------------------------------------------------------------ |
| `write`               | A writer made no usable draft while another draft was rejected     |
| `linkCheck`           | A URL is not a collected one, or has no `https://` scheme          |
| `formatCheck`         | Wrong item count, a missing part, an em dash, or 500 words or more |
| `graniteGroundedness` | A summary, headline or intro is not backed by its sources          |
| `clefRubric`          | The draft was off-task, hype or harmful                            |

Never switch the link or format check off (you cannot). If a guard rejects good drafts week after
week, read the draft before you switch the guard off. Mode `all` rejects less and protects less.

## Keep the evidence

Before you change a prompt, a threshold or a model, keep the `dist/<monday>/` folder of the
bad week (the `digest/` folder and what each source answered). It is the raw material for a new eval case:
[add an eval case from a bad week](../runbooks/maintain/add-eval-case-from-a-bad-week.md).

## Related

- [Run semantics](../architecture/run-semantics.md), [exit codes](../reference/exit-codes.md)
