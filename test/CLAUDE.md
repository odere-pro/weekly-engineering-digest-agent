# Test kit

> What several features' tests share: fakes for the five ports, builders for the common data, the
> cross-feature integration tests, the live Ollama checks and the config fixtures. Unit tests do
> not live here: they sit next to the code. Entry: `import { ... } from 'test/fakes'` (`fakes/index.ts`)
> and `test/builders.ts`.

## Context

```mermaid
flowchart LR
  unit["unit tests beside the code"] -->|"fakes, builders"| kit["test/fakes, builders.ts"]:::focus
  integ["test/integration"] -->|"createWorld"| kit
  integ -.->|"real fs run store"| tmp[("temp folder")]
  live["test/live"] -.->|"LIVE_OLLAMA=1"| ollama[(Ollama)]
  kit -.->|"implement"| ports[["ModelProvider, Guard, SourceFetcher, Delivery, RunStore"]]
  cfg["fixtures/config"] -->|"files"| load["config/load.test.ts"]
  classDef focus stroke-width:3px
```

## Flow

```mermaid
flowchart TD
  need{"what does the test need?"}
  need -->|"one function or step"| unit["unit test beside the code: fakes and builders, injected fetch"]
  need -->|"the whole chain and the files it writes"| integ["integration: createWorld, real fs run store"]
  need -->|"a real model"| live["live: skipped unless LIVE_OLLAMA=1, one at a time"]
  need -->|"a config or .env file"| cfg["fixtures/config"]
```

## Rules

- A fake follows its port. A port change changes the fake in the same commit: `fakes.test.ts` pins
  the fakes, and `fsRunStore.test.ts` runs the same cases on `MemoryRunStore` and the real store.
- The kit stays small. A helper that one feature uses lives in that feature's test or its
  `__fixtures__/`, not here.
- `makeConfig` puts `dataDir` under a temp folder (`TEST_DATA_DIR`), so no test writes to `dist/`.
- Live tests are lane `gpu`: `OLLAMA_MAX_LOADED_MODELS=1` means one at a time on this machine.

## Files

| Path               | Role                                                                                                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fakes/`           | `FakeModelProvider` (scripted, records calls), `yesNoAnswers`, `FakeInputGuard`, `FakeOutputGuard`, `FakeSourceFetcher`, `CapturingDelivery`, `MemoryRunStore`; `index.ts` is the one import, with `fixedClock`, `noopLogger`, `noopTracer` |
| `builders.ts`      | `makeItem`, `makeScoredItem`, `makeDigest`, `makeDraft`, `makeConfig`, `makeRunRecord`                                                                                                                                                      |
| `integration/`     | See below; `integration/CLAUDE.md`                                                                                                                                                                                                          |
| `live/`            | `ollama`, `smoke` (one real dry run on `light`) and `think` checks against a local Ollama                                                                                                                                                   |
| `fixtures/config/` | Valid and broken config and `.env` files for `config/load.test.ts`; `project/` for the cwd lookup                                                                                                                                           |
| `package.test.ts`  | Pins `package.json` (the `prepack` build)                                                                                                                                                                                                   |

`test/integration/` holds the cross-feature tests and their kit in `harness/` (`createWorld` builds
the real chain on `test/fakes` plus the real fs run store; see `test/integration/CLAUDE.md`).
`fakes/`, `integration/` and `live/` are described here and get no `CLAUDE.md` of their own,
except `integration/`, which has one.

## Gotchas

- `fakes/`, `builders.ts` and the fakes' contract are frozen files on issue branches
  (`.claude/rules/parallel-work.md`): a change goes through the coordinator.
- `config/load.test.ts` pins the error texts of the broken files in `fixtures/config/`: adding or
  editing one there can change a test in `src/config/`.
- `think.live.test.ts` imports `GRANITE_CRITERIA` and `parseGraniteScore` from `guards/adapters`.
