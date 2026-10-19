# Threshold commands

## Intent

This folder holds what the two commands do, apart from reading the command line. `capture` calls
the models and saves the raw outputs. `sweep` reads them and saves the tuning result. The entry
file `evals/tuneThresholds.ts` parses the arguments, wires the real app and calls these.

## How it works

1. `captureCommand(options, io)` opens a capture session (`io.openCapture`), picks the file name
   `raw/<local date>-<profile>.json`, and refuses to replace an earlier file unless `--force`.
   That check comes before any case is loaded or model is called.
2. It loads the eval set, runs `captureRaw`, builds the raw capture and saves it (`writeJson`).
   After saving, it checks the data against `RawCaptureSchema` (an invalid capture is an error)
   and returns 1 if any call failed. The file is kept either way. The session is closed in `finally`.
3. `sweepCommand(rawPath, holdout, io)` reads the raw file (`readRaw`), runs `tuneThresholds`
   with the default split or the given holdout weeks, saves `<local date>-<profile>.json` and
   prints `summaryText`.
4. `captureSession(app)` (`session.ts`) wraps the app `digest run` would build: it checks Ollama
   answers and has every profile model, finds the three guards and takes the config thresholds.

## Design

- `CliIo` (`io.ts`) is everything the commands need from outside: folders, the session opener,
  the eval-set loader, the clock and the two streams. Tests pass fakes. The real wiring is in the
  entry file, so nothing here imports `app/container` (only its type), `config/load` or a model.
- The commands return an exit code or throw. The entry file maps a throw to
  `tuneThresholds failed: <message>` and exit 1. Exit codes: 0 done, 1 failed, 2 usage.
- Files are formatted with the repo's prettier config (`writeJson`), like the rest of the repo.
- `session.ts` closes the app if it cannot start the session, so a bad model tag leaks nothing.

## Files

| File                | Role                                                                           |
| ------------------- | ------------------------------------------------------------------------------ |
| `io.ts`             | `CliIo`, `CaptureSession`, `EXIT_OK`, `EXIT_FAILED`, `EXIT_USAGE`              |
| `files.ts`          | `localDate`, `writeJson`, `assertNew`, `readRaw`                               |
| `session.ts`        | `captureSession`: the app, the Ollama check, the guards                        |
| `captureCommand.ts` | `captureCommand`, `CaptureOptions`                                             |
| `sweepCommand.ts`   | `sweepCommand`                                                                 |
| `*.test.ts`         | One per file; the argument parsing is tested in `evals/tuneThresholds.test.ts` |

## Depends on, used by

Depends on: `../capture/`, `../result/`, `../split.ts`, `prettier`, `zod`, `src/shared/errors`,
and the `AppHandle` type of `src/app/container`.
Used by: `evals/tuneThresholds.ts`, `../committedTuning.test.ts`.

## Change it safely

- Run `pnpm vitest run evals/thresholds/cli evals/tuneThresholds`.
- The text printed and the messages in errors are tested. Change them with their tests.
- `capture` is the only command that costs GPU time. Never run it from a test.
