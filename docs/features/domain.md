# Domain

Part of [Features](README.md).

## What it is for

One file holds the schemas and the types that every step, port and adapter share: sources, items,
classifications, digests, drafts, judge scores, guard verdicts and the run record. A single
definition keeps parallel work from drifting apart. It also holds the run status and the exit
codes, so the CLI and the scheduler agree on what a run result means.

## Where it sits

It is the bottom layer. Every other folder may import it, and it imports nothing from them. See
[feature folders](../architecture/feature-folders.md).

## What it does

It has no flow of its own. It describes the data that moves through the pipeline:

- A **source** (an allowlisted feed) gives **items**. An item id is a hash of the normalised URL.
- Classify adds a **classification**. An item plus its classification is a **scored item**.
- Each writer turns the top items into a **digest** (made of digest items). A **draft** is one
  digest plus the writer's tag.
- Guards return **verdicts**. The judge returns a **score**. Both end up in a draft outcome, with
  the ids that rejected the draft in `rejectedBy`.
- The run ends as a **run record**, which is `run.json`. Its status is one of `sent`, `dry-run`,
  `skipped`, `quiet`, `blocked` or `failed`, and the status maps to the exit code: 0 for sent,
  dry-run and skipped, 1 for failed, 2 for blocked, 3 for quiet.
- Defines the five model roles (`classify`, `guardPolicy`, `guardRisk`, `write`, `judge`), the
  three urgency levels (act now, worth a look, good to know) and the week id pattern
  (`2026-W43`, weeks 01 to 53).
- Old data stays readable. A new field on a stored shape is optional, so saved `run.json` files,
  recorded eval weeks and drafts from before the urgency groups still parse.
- The schema already names a `ruleInjection` guard check and a `fallback` flag on the run record.
  They are prepared for a later change; the current pipeline does not produce either.
- Item text is untrusted web content. Parsing it does not make it safe.

## What you can configure

- Nothing. These are fixed types, not settings.
- The values you see in your own files follow them. For the fields of `run.json` see the
  [run record reference](../reference/run-record.md), and for the exit codes see
  [exit codes](../reference/exit-codes.md). The terms are in the [glossary](../reference/glossary.md).

## What can go wrong

- Nothing shows up directly for an operator. A change here is a code change that can break files
  far away, so it is made on the main branch only.
- A hand-edited `run.json` or items file that no longer matches the schema is ignored with a
  warning when the store reads it. See [store](store.md).
- An eval case file that breaks the rules fails the data tests, with the file named. See
  [evals](evals.md).
- Digest rules such as "3 to 5 items" are not enforced here. They live in [checks](checks.md), so
  recorded digests still parse.

## Code and tests

- Folder: [src/domain/](../../src/domain/). Maintainer notes: [CLAUDE.md](../../src/domain/CLAUDE.md).
- No port and no adapters. The file imports `zod` and nothing else.
- Tests sit next to the code: the exit code mapping, the shared test builders, and old records
  without the newer fields.

## Related

- [config](config.md) builds on the source and role types. [store](store.md) validates the run
  record before it saves it.
- [shared](shared.md) uses the exit codes and the week id pattern.
- Almost every other feature page uses these types; start with [digest](digest.md).
