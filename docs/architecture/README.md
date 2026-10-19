# Architecture

Part of the [documentation home](../README.md).

How the agent is built, in plain words. The code is split into feature folders. A fixed
pipeline runs the steps in order. Everything outside the pipeline plugs in through a small
number of interfaces called ports.

| Page                                        | Read it for                                                             |
| ------------------------------------------- | ----------------------------------------------------------------------- |
| [Ports and adapters](ports-and-adapters.md) | Why the pipeline knows no vendor, and the five ports                    |
| [Feature folders](feature-folders.md)       | How `src/` is laid out and where new code goes                          |
| [Data flow](data-flow.md)                   | The pipeline order, step by step, with inputs and outputs               |
| [Run semantics](run-semantics.md)           | Week ids, the lock, idempotency, resume, abort and the six run statuses |
| [Data layout](data-layout.md)               | The files a run leaves on disk                                          |
| [Safety](safety.md)                         | The rules that keep untrusted feed text from doing harm                 |
| [Deployment](deployment.md)                 | Docker services, the Node setup and the host scheduler                  |

Decisions that were weighed and settled live in [decisions/](decisions/) (architecture decision
records, written by a separate effort). Each feature's own design notes are in
[features](../features/README.md), one page per feature, each linking its `CLAUDE.md`.

## The picture in one paragraph

`runDigest` (in `src/digest/`) takes the lock, runs eight steps in order, saves a run record and
delivers the winner. Each step is a plain function in its own feature folder. The model, the
feeds, the guards, the delivery channels and the run store are reached only through ports. One
file, `src/app/container.ts`, turns the config into real adapters, so swapping Ollama for another
model server, or files for a database, means writing an adapter and nothing else.

## Related

- [Features](../features/README.md), [configuration](../configuration/README.md)
- [Glossary](../reference/glossary.md)
