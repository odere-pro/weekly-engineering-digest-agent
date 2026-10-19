# Doctor readiness

> `digest doctor --readiness`: which profile can run on this machine, before the user has a config.
> Prints the machine, one row per profile (`quality`, `fast`, `light`) and the untuned `fallback`,
> and the `ollama pull` lines still missing. Entry: `readinessCommand(options, overrides?)`
> (`readiness.ts`). It contacts only Ollama.

## Flow

```mermaid
flowchart TD
  start["readinessCommand: overrides over defaultIo"] --> target["resolveTarget: data dir, Ollama URL, host from the config"]
  target -->|"config does not load"| defaults["defaults, OLLAMA_URL from the environment, a note saying why"]
  target & defaults --> ask["askOllama: version and models; a failure is 'not reachable'"]
  ask --> rows["buildRow per profile: RAM, Apple silicon, Ollama version, installed tags"]
  rows --> verdict["verdictOf: ready, tight on RAM, pull models, not for this machine"]
  verdict --> render["render: note, machine, table, why a row is tight, pull lists; URL credentials removed"]
  render --> code["exit 0 if any row is not 'not for this machine', else 1"]
```

## Rules

- RAM: `quality` needs 32 GiB, `light` 16 GiB, less 5% (a "32 GB" Linux box reports about 31 GiB).
  `quality` swapped at 32 GiB (2026-10-19), so `fitsRam` says `tight` from 32 GiB up to 48 GiB (an
  estimate) and `yes` from there, the same bands `digest init` warns on. A `tight` row has the verdict
  `tight on RAM` when all its models are installed (a pull still comes first: `pull models`). Under
  the table a line says `quality is tight on 32.0 GiB of RAM:` and quotes `QUALITY_TIGHT_RAM`, the
  measured swap and time that init quotes. It exits 0 like `ready`: the profile runs, slowly.
  `fast` and `fallback` are not measured: they get the 16 GiB floor and print "yes (not measured)".
- A bad `DIGEST_HOST_OS` or `DIGEST_HOST_ARCH` is reported in the note, not thrown. The models folder
  is measured only for a local Ollama (`localhost`, `127.0.0.1`, `[::1]`).

## Files

| File           | Role                                                                                                     |
| -------------- | -------------------------------------------------------------------------------------------------------- |
| `readiness.ts` | `readinessCommand`, `ReadinessCommandOptions`, the default I/O                                           |
| `target.ts`    | `ReadinessIo`, `Target`, `resolveTarget`, `askOllama`, `localModelsDir`, `freeDiskBytes`, `ollamaHealth` |
| `rows.ts`      | `ProfileRow`, `buildRow`, `verdictOf`, `versionStatus`                                                   |
| `table.ts`     | `render`, `machineLines`, `tableLines`, `tightLines`, `pullLines`                                        |
| `memory.ts`    | `GIB`, `hasRam`, `hasQualityMemory`, `hasQualityHeadroom`, `fitsRam`, `QUALITY_TIGHT_RAM`, `formatGiB`   |
| `version.ts`   | `parseVersion`, `compareCore`, `normalizeTag`, `DEVELOPMENT_VERSION`                                     |

`readiness.test.ts` runs the whole command on fakes (RAM, disk, Ollama injected).

## Gotchas

- `memory.ts` is imported by `cli/init/prompts/profile.ts` (`fitsRam`, `formatGiB`,
  `QUALITY_TIGHT_RAM`): init and the table share the RAM bands and the measured wording, so they
  cannot drift (`profile.test.ts` checks that init warns exactly when `fitsRam` is not `yes`). Put a
  new RAM figure or sentence here, not in `cli/init`. `version.ts` is shared with `../checks/`.
- The table text is pinned by tests. Do not reorder the columns.
