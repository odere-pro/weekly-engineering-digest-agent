# CLI

Part of [Features](README.md).

## What it is for

This is the `digest` command. It turns a command line into one call to a handler, prints a short
report and sets the exit code. The real work happens elsewhere: a handler builds the app and runs
the pipeline, or reads files that an earlier run saved. Each command has its own folder.

## Where it sits

It is the outer layer, above the app wiring. Nothing in the pipeline imports it. See
[feature folders](../architecture/feature-folders.md).

## What it does

The global option `-c, --config <path>` (default `digest.config.json`) goes before the command
name. Run commands as `pnpm digest <command>`. In Docker the prefix is
`docker compose run --rm digest <command>`; on a Mac `make docker-init` and `make docker-up` wrap
`init` and `up`.

| Command           | What it does                                                                        |
| ----------------- | ----------------------------------------------------------------------------------- |
| `init`            | Asks for focus areas, profile, time zone and delivery; writes the config and `.env` |
| `doctor`          | One line per check with a `fix:` hint; `--readiness` gives a verdict per profile    |
| `run`             | One full run: `--since`, `--dry-run`, `--force`, `--seed`, `--out`                  |
| `eval`            | Runs the eval set for `--profile <name>` or `all` and prints the scorecard          |
| `fetch`           | Fetches the sources only, with no models, into `dist/fetch/<timestamp>/`            |
| `show <week>`     | Prints a saved run; `--part` picks items, scores, drafts, digest, run or review     |
| `preview <week>`  | Renders the digest for markdown, email and Slack into `dist/preview/<week>/`        |
| `history`         | Lists the last 12 runs (`-n` changes the count)                                     |
| `feedback <week>` | Turns the ticks in `review.md` into `data/feedback/<week>.json`                     |
| `serve`           | Runs the weekly scheduler in the foreground (the Docker Compose service)            |

- Exit codes: 0 sent, dry-run, skipped or fine; 1 failed; 2 blocked; 3 quiet. `doctor` exits 1 on
  any error, and `eval` exits 1 when a hard gate fails. A handler never exits the process itself.
- `init --yes` takes the defaults and refuses to overwrite an existing config. `.env` is merged,
  never replaced, and is written with mode 0600. It also prints an OS schedule when you are not on
  Docker.
- `fetch` calls no model and takes no lock. `--since` accepts 1d to 31d; `--seed` a whole number
  of 0 or more.
- `serve` stops cleanly on the first SIGINT or SIGTERM and waits for a running digest. A second
  signal aborts that run after its current step. A third ends the process.
- Secrets never reach the terminal. Text from feeds and models has control and bidirectional
  characters removed before it is printed.

## What you can configure

- Nothing of its own, apart from the flags above. The config path comes from `-c, --config`.
- Defaults for each command come from the config file. See [config file](../configuration/config-file.md).
- Full flag lists and examples: [CLI commands](../reference/cli-commands.md) and
  [exit codes](../reference/exit-codes.md).

## What can go wrong

- "Invalid --since": use a number of days from 1d to 31d, for example `7d`.
- Config errors print the field to fix and exit 1. Start with `pnpm digest doctor`.
- A command that reads a saved week (`show`, `preview`, `feedback`) exits 1 when the week or the
  part is missing. See [show a week](../runbooks/observe/show-a-week.md).
- `run` exits 1, 2 or 3: see [failed run](../runbooks/debug/failed-run.md),
  [blocked run](../runbooks/debug/blocked-run.md) and [quiet week](../runbooks/debug/quiet-week.md).
  Exit 0 can hide a fallback digest (no model wrote it): look for `Winner:     fallback`.
- `serve` does not see config changes after it starts. Restart it. See
  [stopping and restarts](../operations/stopping-and-restarts.md).
- Common tasks: [run now](../runbooks/run/run-now.md), [dry run](../runbooks/run/dry-run.md),
  [preview a week](../runbooks/run/preview-a-week.md) and
  [fetch sources only](../runbooks/run/fetch-sources-only.md).

## Code and tests

- Folder: [src/cli/](../../src/cli/). Maintainer notes: [CLAUDE.md](../../src/cli/CLAUDE.md).
- No port. One folder per command inside it; `program.ts` registers them. The build bundles the
  entry point into `dist/cli.js`.
- Tests sit next to each handler. They pass fake I/O objects, collect the output and check the
  returned exit code.

## Related

- [app](app.md) builds what `run` and `serve` need. [digest](digest.md) is what `run` calls.
- [scheduler](scheduler.md) is started by `serve` and its schedule text is printed by `init`.
- [evals](evals.md) is what `eval` runs. [config](config.md) loads the files.
