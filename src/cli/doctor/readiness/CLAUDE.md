# Doctor readiness

## Intent

`digest doctor --readiness` answers "which profile can run on this machine?" before the user has a
config. It prints the machine, one row per profile (`quality`, `fast`, `light`) and the untuned
`fallback`, and the `ollama pull` lines still missing. It contacts only Ollama.

## How it works

1. `readinessCommand(options, overrides)` merges `overrides` into `defaultIo` (real RAM, disk,
   Node, home folder, `process.env`, Ollama).
2. `resolveTarget` loads the config for the data folder, Ollama URL and host. If the config does not
   load it uses the defaults and `OLLAMA_URL` from the environment, and keeps a note saying why.
3. `askOllama` gets the version and installed models. A failure becomes "not reachable".
4. `buildRow` judges each row: RAM (`fitsRam`), Apple silicon, Ollama version (`versionStatus`),
   and which tags are installed. `verdictOf` gives `ready`, `pull models` or `not for this machine`.
5. `render` prints the config note, the machine, the table and the pull lists, with URL
   credentials removed. Exit 0 if any row is not "not for this machine", else 1.

## Design

- The RAM figures are 32 GiB for `quality`, 16 GiB for `light`, less 5% (a "32 GB" Linux box reports
  about 31 GiB). `fast` and `fallback` are not measured: they get the 16 GiB floor and print as
  "yes (not measured)". `digest init` uses `hasQualityMemory` and `formatGiB`, so they cannot drift.
- A bad `DIGEST_HOST_OS` or `DIGEST_HOST_ARCH` is reported in the note, not thrown. This path runs
  when nothing else loaded.
- The models folder is measured only for a local Ollama (`localhost`, `127.0.0.1`, `[::1]`).
- `version.ts` is shared with `checks/`: version parsing, `normalizeTag` and the development build.

## Files

| File           | Role                                                                                                     |
| -------------- | -------------------------------------------------------------------------------------------------------- |
| `readiness.ts` | `readinessCommand`, `ReadinessCommandOptions`, the default I/O                                           |
| `target.ts`    | `ReadinessIo`, `Target`, `resolveTarget`, `askOllama`, `localModelsDir`, `freeDiskBytes`, `ollamaHealth` |
| `rows.ts`      | `ProfileRow`, `buildRow`, `verdictOf`, `versionStatus`                                                   |
| `table.ts`     | `render`, `machineLines`, `tableLines`, `pullLines`                                                      |
| `memory.ts`    | `GIB`, `hasRam`, `hasQualityMemory`, `fitsRam`, `formatGiB`, `RowName`                                   |
| `version.ts`   | `parseVersion`, `compareCore`, `normalizeTag`, `DEVELOPMENT_VERSION`                                     |
| `*.test.ts`    | One per file; `readiness.test.ts` runs the whole command on fakes                                        |

## Depends on, used by

Depends on: `report/` (exit codes, `withoutUrlCredentials`), `config` (`load`, `profiles`, `schema`),
`models/adapters/ollama`, `shared`.
Used by: `doctor.ts`, `checks/` (`version.ts`), `init/init.ts` (`formatGiB`, `hasQualityMemory`,
through the bridge `../readiness.ts`).

## Change it safely

- Run `pnpm vitest run src/cli/doctor/readiness`. Tests inject RAM, disk and Ollama; none use the
  network.
- `../readiness.ts` is a one-line bridge for `init`. Remove it when `init` imports `memory.ts`.
- The table text is pinned by tests. Do not reorder the columns.
