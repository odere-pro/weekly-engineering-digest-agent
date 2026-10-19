# Documentation

The wiki for the Engineering Digest Agent: a local-first CLI that reads a fixed list of RSS feeds
and GitHub releases and writes a weekly digest of the 3 to 5 releases that matter.

Every folder has an index. Pages are short and link to each other with relative links, so
GitHub and Obsidian both render them.

## Start here

| You want to                            | Go to                                                                             |
| -------------------------------------- | --------------------------------------------------------------------------------- |
| Understand what this is                | [Overview](overview/README.md)                                                    |
| Install it and get a first digest      | [Getting started](overview/getting-started.md)                                    |
| Do one task (add a source, fix a lock) | [Runbooks](runbooks/README.md)                                                    |
| See how it is built                    | [Architecture](architecture/README.md)                                            |
| Find a setting                         | [Configuration](configuration/README.md), [config keys](reference/config-keys.md) |
| Know how good it is                    | [Evaluation](evaluation/README.md), [current results](evaluation/results.md)      |
| Look up a command or an exit code      | [Reference](reference/README.md)                                                  |

## The folders

| Folder                                    | What is in it                                                                     |
| ----------------------------------------- | --------------------------------------------------------------------------------- |
| [overview/](overview/README.md)           | What it does, cost and hardware, status and limits, getting started               |
| [architecture/](architecture/README.md)   | Ports and adapters, feature folders, data flow, run semantics, safety, deployment |
| [features/](features/README.md)           | One page per feature, each linking its `CLAUDE.md`                                |
| [configuration/](configuration/README.md) | One page per config area                                                          |
| [operations/](operations/README.md)       | Triage, lock, scheduler, retries, disk, known limits                              |
| [runbooks/](runbooks/README.md)           | One runbook per task, grouped by intent                                           |
| [evaluation/](evaluation/README.md)       | One page per eval set and per metric, gates and current results                   |
| [reference/](reference/README.md)         | CLI commands, exit codes, config keys, environment variables, glossary            |

Also here: [default sources](sources.md) (a test parses its table, so it keeps its path),
[the build timeline](build-timeline.html) and the [changelog](../CHANGELOG.md).

## Where each kind of knowledge lives

| Kind                                    | Place                                                                                             |
| --------------------------------------- | ------------------------------------------------------------------------------------------------- |
| How to operate it                       | This wiki                                                                                         |
| Why a feature works the way it does     | The feature's `CLAUDE.md` (`src/<feature>/CLAUDE.md`), linked from [features](features/README.md) |
| Rules for contributors and assistants   | The root [`CLAUDE.md`](../CLAUDE.md) and `.claude/rules/`                                         |
| Decisions that were weighed and settled | [Architecture decisions](architecture/decisions/)                                                 |

## Writing a page

- One topic per page, 120 lines or fewer. Split instead of growing.
- Plain words and short sentences. No em dashes.
- Relative links only. Every new page is listed in its folder's `README.md`.
- Check every command, flag and config key against `pnpm digest <command> --help` and
  `src/config/schema.ts`. Never invent one.
- Runbooks use the same eight headings: purpose, when to use, prerequisites, steps, verify,
  roll back, troubleshooting, related.
- `docs/plan/` is private working material and is not part of the wiki.
