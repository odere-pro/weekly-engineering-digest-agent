# Feature folders

Part of [Architecture](README.md).

`src/` is split by feature, not by type. A feature folder holds its code, its types, its port
(if it has one), its adapters, its tests, its fixtures and a `CLAUDE.md` with its intent and
design. To change a feature you open one folder.

## The folders

| Folder               | What                                                                                | Wiki page                                     |
| -------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------- |
| `src/digest/`        | The weekly run: `runDigest`, run ending, resume, the step loop                      | [digest](../features/digest.md)               |
| `src/sources/`       | `SourceFetcher` port, the collect step, default sources, `adapters/`                | [sources](../features/sources.md)             |
| `src/guards/`        | `Guard` port, the input and output guard steps, guard questions, `adapters/`        | [guards](../features/guards.md)               |
| `src/classify/`      | Classify step and prompt                                                            | [classify](../features/classify.md)           |
| `src/process/`       | Filter by thresholds, cross-week dedupe, rank, top N                                | [process](../features/process.md)             |
| `src/write/`         | Writer panel step and prompt                                                        | [write](../features/write.md)                 |
| `src/checks/`        | Link check and format check (always on)                                             | [checks](../features/checks.md)               |
| `src/select/`        | Judge step and prompt: picks the best passing draft                                 | [select](../features/select.md)               |
| `src/render/`        | Digest view, Markdown, canonical scoring text, review sheet                         | [render](../features/render.md)               |
| `src/delivery/`      | `Delivery` port, `adapters/` (Markdown file, SMTP, Slack)                           | [delivery](../features/delivery.md)           |
| `src/models/`        | `ModelProvider` port, structured output, `adapters/` (Ollama, decision endpoint)    | [models](../features/models.md)               |
| `src/store/`         | `RunStore` port, `adapters/` (run folders, lock, atomic files)                      | [store](../features/store.md)                 |
| `src/domain/`        | The shared types (zod schemas)                                                      | [domain](../features/domain.md)               |
| `src/config/`        | Config schema, profiles, loading                                                    | [config](../features/config.md)               |
| `src/app/`           | The composition root and its decorators                                             | [app](../features/app.md)                     |
| `src/cli/`           | `program.ts` registers commands; one folder per command                             | [cli](../features/cli.md)                     |
| `src/scheduler/`     | The weekly scheduler and OS schedule snippets                                       | [scheduler](../features/scheduler.md)         |
| `src/observability/` | pino logs, OpenTelemetry traces, the redactor                                       | [observability](../features/observability.md) |
| `src/shared/`        | Small stateless helpers: errors, clocks, retry, URLs, text                          | [shared](../features/shared.md)               |
| `evals/`             | Eval data and the harness that scores it                                            | [evals](../features/evals.md)                 |
| `test/`              | Shared test kit (`fakes/`, `builders.ts`), cross-feature `integration/` and `live/` | not a feature                                 |

## Rules for new code

- New code goes in the feature it belongs to, with its test next to it (`x.test.ts`) and
  fixtures in that feature's `__fixtures__/`.
- No source file over 300 lines. When a file grows, extract a subfeature folder with its own
  tests.
- Relative imports have no extension. Named exports only, no default exports, no barrel files.
- Update the feature's `CLAUDE.md` when its intent or design changes.
- Layered context: a contributor, or an AI assistant, reads the root `CLAUDE.md` first, then the
  `CLAUDE.md` of the feature being changed.

## Layers

```text
cli, scheduler, evals     entry points; build the app, call the pipeline
app                       composition root: config in, adapters out
*/adapters/               real systems behind ports
digest                    the run: order, timings, ending
classify, process, write, select, checks, render, guards, sources, models, delivery, store
                          steps and ports; no vendor, no disk, no network
domain, config/schema, shared
                          types and helpers every layer may import
```

## Related

- [Ports and adapters](ports-and-adapters.md), [features index](../features/README.md)
- [Contributor rules](../../CLAUDE.md)
