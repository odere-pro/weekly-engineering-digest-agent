# CLI commands

Part of [Reference](README.md).

Every `digest` command and option, with the defaults the program uses. `pnpm digest <command> --help` shows the same.

## Three ways to run

| Where         | Prefix                                     | Note                                                          |
| ------------- | ------------------------------------------ | ------------------------------------------------------------- |
| From source   | `pnpm digest <command>`                    | Runs `src/cli/index.ts` with tsx. No build needed             |
| After a build | `node dist/cli.js <command>`               | `pnpm build` makes `dist/cli.js`                              |
| Docker        | `docker compose run --rm digest <command>` | The image runs `node dist/cli.js`; default command is `serve` |

On a Mac, `make docker-init` and `make docker-up` wrap `digest init` and `docker compose up -d`.

**Global option**, before the command name: `-c, --config <path>`, the path to
`digest.config.json` (default `digest.config.json`). `-h, --help` works on every command.
A usage error (unknown command or option, missing argument) prints help and exits 1.

## Commands at a glance

| Command           | What it does                                                       | Exit codes |
| ----------------- | ------------------------------------------------------------------ | ---------- |
| `init`            | Ask for focus areas, delivery and profile; write config and `.env` | 0, 1       |
| `doctor`          | Check Ollama, models, feeds, delivery, `.env`, guards, data folder | 0, 1       |
| `run`             | One full run                                                       | 0, 1, 2, 3 |
| `eval`            | Replay the eval set and print the scorecard                        | 0, 1       |
| `fetch`           | Fetch the sources only, no models                                  | 0, 1       |
| `show <week>`     | Print a run's saved data                                           | 0, 1       |
| `preview <week>`  | Render a run's digest for each channel into files                  | 0, 1       |
| `history`         | List past runs                                                     | 0, 1       |
| `feedback <week>` | Turn ticks in `review.md` into eval labels                         | 0, 1       |
| `serve`           | Run the weekly scheduler in the foreground                         | 0, 1       |
| `help [command]`  | Show help                                                          |            |

Meaning of each code: [exit codes](exit-codes.md). A week id looks like `2026-W42`.

## `init [options]`

| Option      | Default | Meaning                           |
| ----------- | ------- | --------------------------------- |
| `-y, --yes` | off     | Accept defaults without prompting |

Asks for focus areas, profile, time zone and delivery. Writes the config (at the `-c` path) and
`.env` (mode 600). `.env` is merged, never replaced. Prints a summary, then an OS schedule snippet
(Node) or the next Docker steps. `--yes` writes profile `light`, the process time zone, two focus
areas and the 24 default sources, and refuses to overwrite a non-empty config. Without `--yes` it
asks before overwriting. Needs no Ollama.

## `doctor [options]`

| Option        | Default | Meaning                                                   |
| ------------- | ------- | --------------------------------------------------------- |
| `--readiness` | off     | Print the machine summary and a verdict for every profile |

Prints one line per check with `✓`, `!` or `✗`, a `fix:` line for each problem, and
`Doctor: all checks passed.` or `Doctor: N errors, M warnings.` Checks: `config`, `ollama`,
`ollama version`, `apple silicon`, `model <tag>`, `think`, `source <id>`, `markdown`, `email`,
`slack`, `.env`, `.env values`, `guards`, `data dir`. A bad feed is a warning, not an error.
`--readiness` works without a config and calls only Ollama.

## `run [options]`

| Option             | Default                 | Meaning                                                 |
| ------------------ | ----------------------- | ------------------------------------------------------- |
| `--since <window>` | `windowDays` (7)        | Collection window, `Nd` with N from 1 to 31             |
| `--dry-run`        | off                     | Write the digest to disk and send nothing               |
| `--force`          | off                     | Run even if the week already has a sent digest          |
| `--seed <n>`       | `models.seed` (42)      | Sampling seed for this run, a whole number of 0 or more |
| `--out <dir>`      | `delivery.markdown.dir` | Folder for the Markdown and HTML digest                 |

Prints `Week`, `Status`, `Items` (`N collected → M in digest`), `Winner`, `Duration`, the paths of
the digest files, each `Failed source:` and `Rejected draft:`, and a note for `dry-run` and
`skipped`. Errors go to stderr. Writes the run folder, the digest files and, on `failed`,
`blocked` or a `quiet` week with nothing collected, a failure note. Exit code follows the run
status ([exit codes](exit-codes.md)). A held lock or a bad option exits 1. When every draft is
rejected, `Winner` reads `fallback`: a digest built from the items' own text was sent (exit 0),
see [blocked run](../runbooks/debug/blocked-run.md).

## `eval [options]`

| Option                 | Default                | Meaning                                                                                                                   |
| ---------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `--profile <name>`     | the configured profile | `quality`, `fast`, `light` or `all`. Saves `evals/scorecards/<date>-<profile>.json`; exit 1 if a hard gate fails          |
| `--only <section>`     | every section          | `guards`, `classify`, `sources` or `weeks` alone; partial scorecard, exit 0; [details](../evaluation/running-sections.md) |
| `--resume`             | off                    | Reuse the week replays a lost run saved                                                                                   |
| `--compare <files...>` | none                   | Compare two saved scorecards; runs nothing, needs no Ollama                                                               |

## `fetch [options]`

| Option             | Default          | Meaning                                |
| ------------------ | ---------------- | -------------------------------------- |
| `--source <id...>` | all sources      | Only these source ids (one or more)    |
| `--since <window>` | `windowDays` (7) | Collection window, `Nd` from 1d to 31d |
| `--out <dir>`      | `dist/fetch`     | Folder for the output                  |

Calls no model and takes no lock. Fetches each source once (10 s limit, no retries), prints a table
(`Source`, `Status`, `HTTP`, `Items`, `Skipped`, `Time`, `Error`) and `Saved to <folder>`. Saves
`raw/<id>.<ext>`, `items.json` and `summary.json` under `<out>/<timestamp>/`. Refuses an `--out`
inside the data folder. Exit 1 if any source failed.

## `show [options] <week>`

| Option          | Default   | Meaning                                                  |
| --------------- | --------- | -------------------------------------------------------- |
| `--part <name>` | a summary | `items`, `scores`, `drafts`, `digest`, `run` or `review` |
| `--json`        | off       | Print the saved JSON as it is                            |

Reads the run folder only. The summary lists profile, counts, winner, channels reached, guards
off, timings, rejected drafts, failed sources and the error. `items`, `scores` and `drafts` print
tables. `run` always prints `run.json`. Exit 1 with a message for a bad week id, an unknown part,
no saved run, or a missing file.

## `preview [options] <week>`

| Option             | Default        | Meaning                               |
| ------------------ | -------------- | ------------------------------------- |
| `--channel <name>` | `all`          | `markdown`, `email`, `slack` or `all` |
| `--out <dir>`      | `dist/preview` | Folder for the previews               |

Writes `<out>/<week>/digest.md`, `email.html`, `email.txt` and `slack.json` (those for the chosen
channel), prints their paths, and sends nothing. Needs a run with a winning draft.

## `history [options]`

| Option                | Default | Meaning                            |
| --------------------- | ------- | ---------------------------------- |
| `-n, --limit <count>` | 12      | Number of runs, a positive integer |

Prints `Week`, `Status`, `Items` (`collected → in digest`), `Duration` and `Winner`, newest first,
or `No runs yet.`

## `feedback <week>`

No options. Reads `<dataDir>/runs/<week>/review.md` and writes `<dataDir>/feedback/<week>.json`.
Prints `<week>: <n> wrong pick(s), <m> missed -> <path>`. Exit 1 when the sheet is missing,
belongs to another week, or was edited beyond the tick boxes.

## `serve`

No options. Loads the config once, starts the scheduler, and waits. First `SIGINT` or `SIGTERM`
stops the scheduler and lets a running digest finish. A second stops that run after its current
step. A third ends the process. Exit 0 after a stop; exit 1 on a start-up error.

## Related

- [Exit codes](exit-codes.md) and [files and paths](files-and-paths.md)
- [CLI feature](../features/cli.md), [src/cli/CLAUDE.md](../../src/cli/CLAUDE.md) and [runbooks](../runbooks/README.md)
