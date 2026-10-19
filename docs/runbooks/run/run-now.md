# Run now

Part of [Runbooks](../README.md) / Run.

## Purpose

Produce this week's digest and deliver it to every configured channel right away, instead of
waiting for the schedule.

## When to use

- The week has no digest yet and you do not want to wait for Monday.
- A week ended `failed` and you fixed the cause.
- To try the pipeline without sending, use [Dry run](dry-run.md).
- To run a week that is already `sent`, use [Force a week](force-a-week.md).
- A week that reached only some channels is finished by a plain `digest run`:
  see [Resume a partial delivery](../recover/resume-partial-delivery.md).

## Prerequisites

- A green `digest doctor` and a [first run](../set-up/first-run.md) that worked.
- Nobody else is running the week. One run at a time per `dataDir` (the lock in
  `dist/digest.lock`).
- Email and Slack recipients will get the digest. Use a dry run if you are only testing.
- Time: about 6 minutes for `light`, about 1 hour for `quality`. In Docker the command is
  `docker compose run --rm digest run` (a second container is fine: the lock stops overlap).

## Steps

1. Run the week.

   ```bash
   pnpm digest run
   ```

   Options: `--since <N>d` (window, `1d` to `31d`, default `windowDays`), `--seed <n>` (sampling
   seed, overrides `models.seed`), `--out <dir>` (folder for the digest files for this run).

2. Read the summary and the exit code.

   ```text
   Week      2026-W43
   Status    sent
   Items     131 collected → 5 in digest
   Winner    gemma4:e4b-mlx
   Duration  5m 40s
   Digest    dist/2026-10-19/digest/digest.md
   Markdown  dist/2026-10-19/digest/2026-W43.md
   HTML      dist/2026-10-19/digest/2026-W43.html
   ```

| Exit | Status                | Next                                                                                                                                                    |
| ---- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | `sent` (or `skipped`) | Done. `skipped` means the week was already sent. A `Winner:     fallback` line means no model wrote the digest: [Blocked run](../debug/blocked-run.md). |
| 1    | `failed`              | [Failed run](../debug/failed-run.md)                                                                                                                    |
| 2    | `blocked`             | [Blocked run](../debug/blocked-run.md)                                                                                                                  |
| 3    | `quiet`               | [Quiet week](../debug/quiet-week.md)                                                                                                                    |

## Verify

- Exit code 0 and `Status    sent`.
- `pnpm digest history -n 1` lists the week as `sent`.
- `pnpm digest show <week>` has a `Delivered:` line that names every channel you configured
  (`markdown`, plus `email` and `slack` if set).
- `<week>.md` and `<week>.html` exist in `delivery.markdown.dir`, or with no such key in the
  week's folder `dist/<monday>/digest/` (Docker: the same, in `./dist`).

## Roll back

A sent email or Slack message cannot be recalled. The local files can be deleted. The week stays
`sent`, so another `digest run` ends `skipped`; to send a corrected digest see
[Force a week](force-a-week.md).

## Troubleshooting

| Symptom                                                    | Cause                                   | Fix                                                  |
| ---------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------- |
| `Invalid --since "x". Use a number of days from 1d to 31d` | Wrong format                            | Use `7d`, `14d`, ...                                 |
| `option '--seed <n>' argument 'x' is invalid`              | Not a whole number of 0 or more         | Use `--seed 42`.                                     |
| `Another run is in progress (pid ..., week ...)`           | A run, or a stale lock, holds the lock  | Wait, or see [Stuck lock](../debug/stuck-lock.md).   |
| `Status    skipped`                                        | The week already has a sent digest      | Nothing to do, or [Force a week](force-a-week.md).   |
| `Ollama is not reachable ... Start Ollama and run again.`  | Ollama is down or `OLLAMA_URL` is wrong | Start Ollama and run `digest doctor`.                |
| `No digest.config.json found ... Run "digest init" first.` | Wrong folder, or no config              | `cd` to the clone, or pass `-c <path>` before `run`. |

## Related

- [Dry run](dry-run.md), [Force a week](force-a-week.md), [Triage](../../operations/triage.md)
- [Run semantics](../../architecture/run-semantics.md), [Exit codes](../../reference/exit-codes.md)
- [src/digest/CLAUDE.md](../../../src/digest/CLAUDE.md)
