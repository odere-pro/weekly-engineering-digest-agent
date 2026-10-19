# Domain

Part of [Features](README.md).

## What it is for

`src/domain/schemas.ts` holds the schemas and the types that several features share: sources,
items, digests, drafts, the week id, the step names, the run status and the exit codes. A single
definition keeps parallel work from drifting apart, and the CLI and the scheduler agree on what a
run result means. A type that only one feature owns lives in that feature, next to the code that
produces it (see the table below).

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
- Defines the three urgency levels (act now, worth a look, good to know) and the week id pattern
  (`2026-W43`, weeks 01 to 53).
- Old data stays readable. A new field on a stored shape is optional, so saved `run.json` files,
  recorded eval weeks and drafts from before the urgency groups still parse. `fallback` on the run
  record is one such optional field.
- Item text is untrusted web content. Parsing it does not make it safe.

Types that moved into the feature that owns them:

| Types                          | Now in                           |
| ------------------------------ | -------------------------------- |
| `Role` (the five model roles)  | `src/models/roles.ts`            |
| `Classification`, `ScoredItem` | `src/classify/classification.ts` |
| `GuardCheckId`, `GuardVerdict` | `src/guards/guardVerdict.ts`     |
| `JudgeScore`                   | `src/select/judgeScore.ts`       |
| `DeliveryId`                   | `src/delivery/deliveryId.ts`     |
| `RunRecord`, `DraftOutcome`    | `src/store/runRecord.ts`         |

The shared file keeps `Source`, `Item`, `Digest`, `DigestItem`, `Draft`, `Urgency`, `WeekIdSchema`,
`StepName`, `RunStatus`, `ExitCode` and `exitCodeFor`. The five roles are `classify`,
`guardPolicy`, `guardRisk`, `write` and `judge`.

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
- Tests sit next to the code: the exit code mapping and the shared test builders. The run-record
  parse cases (old records without `sampling`, `afterProcess` or `fallback`) are in
  `src/store/runRecord.test.ts`.

## Related

- [config](config.md) builds on the source type and the role type from `models/roles.ts`.
  [store](store.md) owns the run record schema and validates the record before it saves it.
- [shared](shared.md) uses the exit codes and the week id pattern.
- Almost every other feature page uses these types; start with [digest](digest.md).
