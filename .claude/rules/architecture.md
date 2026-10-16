---
paths:
  - 'src/**'
  - 'evals/**'
---

# Architecture: ports and adapters

The core runs the whole chain and knows no vendor, file or cloud. Everything outside it sits
behind one of five ports, so swapping Ollama for Bedrock or files for S3 means adding an adapter.

## Dependency direction

```
cli / scheduler / evals  →  app/container  →  adapters  →  ports  ←  core
                                         ↘  config/load        ↖  shared, config/schema, config/profiles
```

- `src/core/**` and `src/ports/**` import only from `core`, `ports`, `shared`, `config/schema`
  and `config/profiles`. ESLint (`no-restricted-imports`) fails the build otherwise.
- Adapters implement a port and may import `shared` and `config`, never `core/steps` or `cli`.
- Only `src/app/container.ts` turns config into adapters. CLI, scheduler and evals call it.

## Step shape

- A step is a plain async function `(input, deps) => output` in `src/core/steps/`.
  Deps are interfaces (ports, `Logger`, `Clock`), never concrete adapters.
- `src/core/workflow.ts` (Mastra, pinned) only wraps steps; it holds no business logic.
- Prompts for a step live in `src/core/prompts/<step>.ts`, owned by that step's issue.

## Model calls

- Ask for a role (`classify`, `guardPolicy`, `guardRisk`, `write`, `judge`), never a model tag.
  The only exception: the write step passes each writer tag from the profile as an opaque id.
- Decision questions (`decide`) for classify, policy guards and the judge; `generate` only for
  writing and Granite. Structured output always goes through `generateStructured()`.
- Timeouts and retries per role live in the Ollama adapter. Feed timeouts and retries
  (10 s, 2 retries) live in the collect step, using `shared/retry`.
