# Doctor

## Intent

`digest doctor` tells the user in one screen whether this machine can run a digest and what to fix.
It checks the config, Ollama, the models, every feed, the delivery secrets, `.env`, the guards and
the folders a run writes to, and prints a `fix:` line for each problem. `--readiness` prints the
machine and a verdict per profile instead. The entry file only wires the parts; each part is a
subfeature folder.

## How it works

1. `doctorCommand(options, overrides)` merges `overrides` into `defaultIo` (real disk, `fetch`,
   clock, stdout, `.env` in the working directory).
2. With `--readiness` it hands over to `readinessCommand` and returns its exit code.
3. Otherwise `tryLoadConfig` loads the config. If that fails, it prints one `✗ config` line with a
   fix, runs no other check and returns 1.
4. It asks the model provider for `health()` once (Ollama version and installed models).
5. It collects the results in this order: config, ollama and its version, apple silicon, models,
   think, one line per source, the markdown folder, email, Slack, `.env`, `.env values`, guards,
   data folder.
6. `report` prints them with a summary and returns 1 if any is an error, else 0.

## Design

- Doctor sends nothing. It reads one item from each feed (last day, 10 s each) and asks Ollama for
  its version and models. A broken feed is a warning, because a run skips that feed.
- All outside access goes through `DoctorIo` (`types.ts`): config loader, provider, `fetch`, clock,
  `stat`, `lstat`, `readFile`, `access`, stdout. Tests replace it with a fake machine.
- Output never carries a secret. `report` redacts the whole text, and `.env` checks name a key and a
  line, never a value.
- The platform checked is the one the loader resolved for the profile, so a bad
  `DIGEST_HOST_OS` is a config error, and the checks judge the same host the profile was chosen for.

## Files

| File / folder                            | Role                                                                                     |
| ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| `doctor.ts`                              | `doctorCommand`, `DoctorCommandOptions`, `defaultIo`, `tryLoadConfig`                    |
| `types.ts`                               | `DoctorIo`, `PathInfo`                                                                   |
| `errorCode.ts`                           | `errorCode`, `isNotFound`: read a Node error code                                        |
| `readiness.ts`                           | Bridge: `formatGiB`, `hasQualityMemory` for `init` until W10-B23                         |
| `report/`                                | Result type, lines, summary, exit codes, URL credential stripper. See `report/CLAUDE.md` |
| `checks/`                                | Ollama, models, sources, delivery, guards. See `checks/CLAUDE.md`                        |
| `envFile/`                               | `.env` permissions and values cut at `#`. See `envFile/CLAUDE.md`                        |
| `folders/`                               | Can a run write to or create a folder. See `folders/CLAUDE.md`                           |
| `readiness/`                             | `--readiness`: profile table, RAM, versions. See `readiness/CLAUDE.md`                   |
| `__fixtures__/`                          | `doctorHarness.ts`: the fake machine the tests run against                               |
| `doctor.test.ts`                         | Wiring: all green, config failure, credential URLs, host platform                        |
| `doctor.defaults.test.ts`                | The real config loader, provider and `fetch` (stubbed), and stdout                       |
| `doctor.fs.test.ts`                      | The real `stat`, `lstat`, `readFile` and `access` on a temporary folder                  |
| `doctor.readiness.test.ts`               | The `--readiness` flag                                                                   |
| `errorCode.test.ts`, `readiness.test.ts` | The helper and the bridge                                                                |

## Depends on, used by

Depends on: `app/container` (`createModelProvider`), `config`, `models/adapters/ollama`,
`sources/adapters` (rss, GitHub releases), `guards/guardVerdict` (a type), `shared`.
Used by: `cli/program.ts` (`doctorCommand`), `cli/init/init.ts` (`formatGiB`, `hasQualityMemory`
through `readiness.ts`).

## Change it safely

- Run `pnpm vitest run src/cli/doctor`. A test builds a fake machine with `harness` or `runDoctor`
  and reads the printed lines with `resultFor`.
- Printed text, result order and exit codes are public. Tests pin them.
- A new check is a function in `checks/` (or its own folder if it is complex), one line in
  `doctorCommand` and a test.
- A folder here never imports `doctor.ts`. Shared types go in `types.ts`.
