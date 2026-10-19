---
paths:
  - 'src/**'
  - 'evals/**'
---

# Architecture: feature folders, ports and adapters

The code is split by feature. Each feature folder holds its code, its types, its port (if it has
one), its adapters, its tests and fixtures, and a `CLAUDE.md` with its intent and design.

The pipeline runs the whole chain and knows no vendor, file or cloud. Everything outside it sits
behind one of five **ports**, interfaces the pipeline owns and calls. An **adapter** plugs a real
system into a port. Swapping Ollama for Bedrock, or files for S3, means adding an adapter.

| Port            | Lives in        | Adapters in                                            |
| --------------- | --------------- | ------------------------------------------------------ |
| `ModelProvider` | `src/models/`   | `src/models/adapters/` (Ollama: chat and decisions)    |
| `Guard`         | `src/guards/`   | `src/guards/adapters/` (Granite Guardian, clef policy) |
| `SourceFetcher` | `src/sources/`  | `src/sources/adapters/` (RSS, GitHub, fetch pipeline)  |
| `Delivery`      | `src/delivery/` | `src/delivery/adapters/` (Markdown file, SMTP, Slack)  |
| `RunStore`      | `src/store/`    | `src/store/adapters/` (files, lock)                    |

## Dependency direction

```
cli / scheduler / evals  →  app/container  →  */adapters/  →  ports  ←  pipeline features
                                         ↘  config/load             ↖  shared, domain, config/schema
```

- Pipeline features (`digest`, `domain`, `classify`, `process`, `write`, `select`, `checks`,
  `render`) and the top level of `sources`, `guards`, `models`, `delivery`, `store` never import
  `**/adapters/**`, `cli`, `scheduler`, `observability`, `app`, `config/load`, `node:fs`, `ollama`
  or `nodemailer`. ESLint (`no-restricted-imports`) fails the build otherwise.
  The rule covers every subfolder of those features too, except their own `adapters/`.
- Adapters implement a port and may import `shared`, `domain` and `config`, never `cli`.
- Only `src/app/container.ts` turns config into adapters. CLI, scheduler and evals call it.

## Types and subfeatures

- A type lives in the feature that owns it: `models/roles.ts` (`Role`), `classify/classification.ts`
  (`Classification`, `ScoredItem`), `guards/guardVerdict.ts`, `select/judgeScore.ts`,
  `delivery/deliveryId.ts`, `store/runRecord.ts` (`RunRecord`). `domain/schemas.ts` keeps only what
  several features share (`Source`, `Item`, `Digest`, `Draft`, `WeekId`, `StepName`, `RunStatus`, `ExitCode`).
- A feature grows by subfeature folders, not by long files: no source file over 300 lines. A
  subfeature is one responsibility (`cli/init/envFile/`), with its code, tests and a `CLAUDE.md`.
  The feature's entry file stays and calls the subfeatures. Method: `docs/plan/PHASE-B-STANDARD.md`.

## Step shape

- A step is a plain async function `(input, deps) => output` in its feature folder
  (`src/classify/classify.ts`). Deps are interfaces (ports, `Logger`, `Clock`), never adapters.
- `src/digest/workflow.ts` runs the steps in order with a plain loop; it holds no business logic.
  No workflow framework: ADR 0001 (`docs/architecture/decisions/0001-mastra.md`) removed Mastra.
- A step's prompt sits next to it: `src/<feature>/<feature>Prompt.ts`.

## Imports

- Relative imports have no extension: `import { collectStep } from '../sources/collect'`.
  `moduleResolution` is `bundler`; tsx, Vitest and esbuild resolve them.
- Named exports only, no default exports, no barrel files.

## Model calls

- Ask for a role (`classify`, `guardPolicy`, `guardRisk`, `write`, `judge`), never a model tag.
  The only exception: the write step passes each writer tag from the profile as an opaque id.
- Decision questions (`decide`) for classify, policy guards and the judge; `generate` only for
  writing and Granite. Structured output always goes through `generateStructured()`
  (`src/models/structured.ts`).
- Timeouts and retries per role live in the Ollama adapter. Feed timeouts and retries
  (10 s, 2 retries) live in the collect step (`src/sources/collect.ts`), using `shared/retry`.
