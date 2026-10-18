# CLI

## Intent

The `digest` command. It turns a command line into one call to a handler, prints a short report and
sets the exit code. The real work happens elsewhere: a handler builds the app with `buildApp` and
runs the pipeline, or reads files a run saved earlier. Each command has its own folder.

## How it works

1. `index.ts` is the entry that `scripts/build.mjs` bundles to `dist/cli.js`. It calls
   `buildProgram(setExitCode)` and `parseAsync`. An error that escapes is printed and the exit code is 1.
2. `program.ts` registers the 10 commands with commander and a global `-c, --config <path>`
   (default `digest.config.json`). `withConfig` adds that path to each handler's options. Each action
   ends in `setExitCode(await xCommand(...))`. A handler never calls `process.exit`.
3. Every handler is `xCommand(options, overrides?)` and returns an `ExitCode` (0 sent or ok, 1 failed,
   2 blocked, 3 quiet). `overrides` replaces the injected I/O: config loader, app builder, files,
   `stdout` and `stderr`.

The commands:

- `init` (`initCommand`): asks for focus areas, profile, time zone and delivery, or takes defaults
  with `--yes`. Writes `digest.config.json` and a `.env` with mode 0600, then prints an OS schedule
  from `renderOsSchedule` or the Docker next steps.
- `doctor` (`doctorCommand`): one line per check (config, Ollama and version, Apple silicon, models,
  `think`, every source, delivery secrets, `.env`, guards, data folder) with a `fix:` line. Exit 1 on
  any error. `--readiness` (`readinessCommand`) prints the machine and a verdict per profile.
- `run` (`runCommand`): loads config, builds the app, calls `runDigest`, closes the app and prints a
  summary. Options: `--since 1d..31d`, `--dry-run`, `--force`, `--seed`, `--out`.
- `eval` (`evalCommand`): runs `runEval` for one profile or `all`, prints the scorecard, saves it to
  `evals/scorecards/` and exits 1 if a hard gate fails. `EVAL_JUDGE` names a judge model.
- `fetch` (`fetchCommand`): fetches the sources once with a run's fetchers plus a debug tap, and saves
  raw bodies, `items.json` and `summary.json` under `dist/fetch/<timestamp>/`. Exit 1 if a source failed.
- `show <week>` (`showCommand`): prints a saved run's summary, or one `--part` (items, scores, drafts,
  digest, run, review) as a table or, with `--json`, as saved.
- `preview <week>` (`previewCommand`): renders the winning draft for markdown, email and Slack into
  `dist/preview/<week>/` and sends nothing.
- `history` (`historyCommand`): lists the last 12 runs (`-n` changes it): status, items, duration, winner.
- `feedback <week>` (`feedbackCommand`): reads the ticks in `review.md` and writes
  `data/feedback/<week>.json`. `evals/feedbackToLabels.ts` merges that into the eval labels.
- `serve` (`serveCommand`): builds the app, starts the scheduler, waits for SIGINT or SIGTERM. The
  first signal stops the scheduler and waits for the running digest. A second aborts that run after
  its current step. A third ends the process.

## Design

- A `DigestError` carries its exit code. `run`, `fetch`, `show`, `preview`, `history` and `feedback`
  catch every error. `init`, `eval` and `serve` return the code for a `DigestError` and rethrow the rest.
- Secrets never reach the terminal. `run` and `fetch` use `redactSecrets`, `show` and `preview` use
  `createRedactor(knownSecrets(...))`, and `doctor` also strips `user:pass@` from URLs. `doctor` names
  `.env` keys and line numbers, never values.
- Text from feeds and models is untrusted. `show`, `preview`, `fetch` and `eval` remove control,
  bidi and tag characters before printing. Tables cut long cells.
- `fetch` calls no model, takes no lock and refuses an `--out` inside the data folder.
- `init` writes `.env` through a temp file and a rename, or in place on a Docker bind mount, and
  stops if the file stays readable by others. It suggests `light` until `quality` has a measured baseline.
- Limits: `--since` 1 to 31 days, `--seed` a whole number of 0 or more, `--limit` 1 or more. A source
  check in `doctor` and a source fetch in `fetch` each time out at 10 seconds.

## Files

| File                   | Role                                                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- |
| `index.ts`             | Entry point: builds the program, parses `argv`, sets the exit code                                          |
| `program.ts`           | Command registration, option parsing (`positiveInt`, `nonNegativeInt`)                                      |
| `init/init.ts`         | `initCommand`, `recommendProfile`, `resolveOllamaUrl`, prompts and file writes                              |
| `doctor/doctor.ts`     | `doctorCommand` and all checks                                                                              |
| `doctor/readiness.ts`  | `readinessCommand`, RAM helpers, version helpers, `normalizeTag`                                            |
| `run/run.ts`           | `runCommand`, summary, dry-run copy of the digest                                                           |
| `eval/eval.ts`         | `evalCommand`, `formatScorecard`, judge set-up                                                              |
| `fetch/fetch.ts`       | `fetchCommand`, per-source report, raw and parsed output                                                    |
| `show/show.ts`         | `showCommand`: summary and tables of a saved run                                                            |
| `preview/preview.ts`   | `previewCommand`: per-channel files from the winning draft                                                  |
| `history/history.ts`   | `historyCommand`, `formatDuration`, `formatRunDuration`                                                     |
| `feedback/feedback.ts` | `feedbackCommand`: review sheet to feedback JSON                                                            |
| `serve/serve.ts`       | `serveCommand`, `waitForShutdownSignal`                                                                     |
| `*.test.ts`            | Next to each handler (`doctor.readiness`, `eval.format`, `fetch.tap`, `serve.notify`) and `program.test.ts` |
| `__fixtures__/`        | None. Tests pass fake I/O objects and temp folders.                                                         |

## Depends on, used by

Depends on: `app` (`container`, `redacting`), `config`, `digest`, `scheduler`, `evals/`, the adapters of `sources`, `models`, `store` and `delivery`, `render`, `observability` and `shared`.
Used by: nothing in `src`. `scripts/build.mjs` bundles `index.ts`, and `test/integration/harness.ts` calls `runCommand`.

## Change it safely

- Run `pnpm vitest run src/cli`. A test passes overrides, collects `stdout` and `stderr`, and checks
  the returned code. Try a command by hand with `pnpm digest <command>`.
- `program.ts` and `index.ts` are frozen on issue branches. A new command needs the coordinator to
  register it, and `program.test.ts` lists every command name.
- `run`, `show` and `fetch` import the duration helpers from `history.ts`. `init` imports the RAM
  figures from `doctor/readiness.ts` (32 GiB `quality`, 16 GiB `light`, 5% slack) so they cannot
  drift. `eval.ts` reaches into `evals/`, so renaming an export there breaks it.
- Exit codes are public. Do not renumber them. Tests also pin the printed text.
- `init.ts` (773 lines) and `doctor.ts` (681) are near the 800 line limit. Split before you add more.
