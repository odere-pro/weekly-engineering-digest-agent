# Ports and adapters

Part of [Architecture](README.md).

## The idea in plain words

The pipeline decides _what_ happens: collect, check, score, write, pick, deliver. It does not
know _how_ any outside system works. It does not know Ollama, an RSS parser, SMTP, Slack or the
disk.

For each outside system the pipeline defines a **port**: an interface that says what it needs
("give me the items of this source", "answer these questions about this text"). An **adapter**
is the code that plugs a real system into a port. The pipeline owns the port. The adapter
follows it.

```text
cli / scheduler / evals  ->  app/container  ->  */adapters/  ->  ports  <-  pipeline features
```

Why bother:

- **Swap a part without touching the rest.** Another model server, a database run store or an
  SES mail adapter is a new adapter.
- **Test without the world.** Unit tests use fakes (`test/fakes`) and never call a feed, a model
  or a mail server.
- **Keep secrets and I/O in a few places.** Only adapters and the composition root touch the
  network and the disk, so a leak is easier to prevent and to find.

## The ports

| Port            | Lives in                       | What it does                                         | Real adapters                                       |
| --------------- | ------------------------------ | ---------------------------------------------------- | --------------------------------------------------- |
| `ModelProvider` | `src/models/ModelProvider.ts`  | `generate` (text), `decide` (class odds), `health`   | Ollama                                              |
| `InputGuard`    | `src/guards/Guard.ts`          | `checkItem`: a verdict on one collected item         | the injection rule guard, clef policy, Granite risk |
| `OutputGuard`   | `src/guards/Guard.ts`          | `checkDraft`: a verdict on one draft and its sources | clef rubric, Granite groundedness                   |
| `SourceFetcher` | `src/sources/SourceFetcher.ts` | Items from one kind of source                        | RSS and Atom, GitHub releases (Atom and REST)       |
| `Delivery`      | `src/delivery/Delivery.ts`     | Send a digest or a failure note                      | Markdown file, SMTP, Slack                          |
| `RunStore`      | `src/store/RunStore.ts`        | Run folders, history, the run lock                   | Files on a local disk                               |

Each port file sits at the top of its feature folder, and its adapters live in the `adapters/`
folder next to it. There are five port files and six interfaces: the guard port is a pair in one
file, `Guard.ts`, and there is no type named `Guard`. An input guard judges one collected item:
the rule guard checks every item before any model sees it, and the model guards check the items
`process` picked before any writer sees them. An output guard judges each draft against the items
it cites.

`ModelProvider` has one adapter, `createOllamaProvider` in `src/models/adapters/ollama.ts`.
`adapters/systemone.ts` is not a second adapter: it holds the helpers the Ollama adapter uses to
build `/v1/systemone` questions and read the answers. Its parts sit in `call/`, `chat/`, `decide/`
and `health/` next to it: see `src/models/adapters/CLAUDE.md`.

`DigestDeps` in `src/digest/types.ts` lists every port a run takes.

## Logger, Tracer and Clock

The run also takes three small interfaces from `src/shared/`. They work like ports, but no
feature owns them and they have no `adapters/` folder. They sit in `shared` so pipeline code can
use them without importing `observability`.

| Interface | Lives in                  | What it does                        | Real implementation                                   | In tests     |
| --------- | ------------------------- | ----------------------------------- | ----------------------------------------------------- | ------------ |
| `Logger`  | `src/shared/telemetry.ts` | Log lines; `child` adds fields      | pino, `createLogger` in `src/observability/`          | `noopLogger` |
| `Tracer`  | `src/shared/telemetry.ts` | Runs a function inside a named span | OpenTelemetry, `createTracer` in `src/observability/` | `noopTracer` |
| `Clock`   | `src/shared/clock.ts`     | `now()`                             | `systemClock`                                         | `fixedClock` |

## The composition root

`src/app/container.ts` is the only place that turns config into adapters. It reads the loaded
config and secrets, builds the adapters, wraps them in retry and redaction decorators, and hands
the core a `DigestDeps` object. The CLI, the scheduler and the evals all call it. See
[app](../features/app.md).

## The rule, and how it is enforced

Pipeline features never import `**/adapters/**`, the CLI, the scheduler, `observability`, `app`,
`config/load`, `node:fs`, `ollama` or `nodemailer`. ESLint fails the build if they do
(`no-restricted-imports`). Adapters may import `shared`, `domain` and `config`, never `cli`.

Which folders are "pipeline" and which are not is listed in [feature folders](feature-folders.md).

## Two kinds of model call, and a health check

The `ModelProvider` port has two model calls. `decide` asks typed questions (yes/no, a choice, a
score) and gets probabilities back. It is used by classify, the policy guards and the judge.
`generate` returns free text and is used by the writers and by Granite. A third method, `health`,
calls no model: it reports whether Ollama is reachable and which models it has. A run checks it
before the first step, and `digest doctor` shows it. Pipeline code asks for a **role**
(`classify`, `guardPolicy`, `guardRisk`, `write`, `judge`), never for a model tag. A
[profile](../configuration/profiles.md) maps each role to a tag. See [models](../features/models.md).

## Related

- [Architecture rules for contributors](../../.claude/rules/architecture.md)
- [Feature folders](feature-folders.md), [data flow](data-flow.md)
