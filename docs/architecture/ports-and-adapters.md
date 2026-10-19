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

## The five ports

| Port            | Lives in        | What it does                                  | Real adapters                                                      |
| --------------- | --------------- | --------------------------------------------- | ------------------------------------------------------------------ |
| `ModelProvider` | `src/models/`   | `generate` (text) and `decide` (class odds)   | Ollama chat, decision endpoint (`/v1/systemone`)                   |
| `Guard`         | `src/guards/`   | Input and output checks, one verdict per call | the injection rule guard, clef policy and rubric, Granite Guardian |
| `SourceFetcher` | `src/sources/`  | Items from one kind of source                 | RSS and Atom, GitHub releases (Atom and REST)                      |
| `Delivery`      | `src/delivery/` | Send a digest or a failure note               | Markdown file, SMTP, Slack                                         |
| `RunStore`      | `src/store/`    | Run folders, history, the run lock            | Files on a local disk                                              |

Each port is one file at the top of its feature folder (for example `src/models/ModelProvider.ts`).
Its adapters live in the `adapters/` folder next to it.

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

## Two kinds of model call

The `ModelProvider` port has two calls. `decide` asks typed questions (yes/no, a choice, a score)
and gets probabilities back. It is used by classify, the policy guards and the judge. `generate`
returns free text and is used by the writers and by Granite. Pipeline code asks for a **role**
(`classify`, `guardPolicy`, `guardRisk`, `write`, `judge`), never for a model tag. A
[profile](../configuration/profiles.md) maps each role to a tag. See [models](../features/models.md).

## Related

- [Architecture rules for contributors](../../.claude/rules/architecture.md)
- [Feature folders](feature-folders.md), [data flow](data-flow.md)
