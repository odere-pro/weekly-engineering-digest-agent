# Domain schemas

## Intent

One file holds the zod schemas and the TypeScript types that several features share: sources,
items, digests, drafts, the week id, the step names, the run status and the exit codes. One
definition keeps parallel workers from drifting apart, and the CLI and the scheduler agree on what
a run result means. A type that only one feature owns lives in that feature, next to the code that
produces it (see the table below).

## How it works

This folder has no flow of its own. It describes the data that moves through the pipeline:

1. A `Source` (an allowlisted feed) gives `Item`s. `Item.id` is the hash of the normalized URL.
2. `classify` adds a `Classification` (`classify/classification.ts`). An item plus its
   classification is a `ScoredItem`.
3. Each writer turns the top items into a `Digest` (made of `DigestItem`s). A `Draft` is one
   digest plus the writer tag.
4. Guards return `GuardVerdict`s (`guards/guardVerdict.ts`). The judge returns a `JudgeScore`
   (`select/judgeScore.ts`). Both end up in a `DraftOutcome`, with the ids that rejected the draft
   in `rejectedBy`.
5. The run ends as a `RunRecord` (`store/runRecord.ts`). `exitCodeFor(status)` turns its
   `RunStatus` into an `ExitCode`.

Where the feature-owned types live:

| Types                          | File                         |
| ------------------------------ | ---------------------------- |
| `Role`                         | `models/roles.ts`            |
| `Classification`, `ScoredItem` | `classify/classification.ts` |
| `GuardCheckId`, `GuardVerdict` | `guards/guardVerdict.ts`     |
| `JudgeScore`                   | `select/judgeScore.ts`       |
| `DeliveryId`                   | `delivery/deliveryId.ts`     |
| `RunRecord`, `DraftOutcome`    | `store/runRecord.ts`         |

## Design

- Frozen file. Change it on `main` only, then rebase open branches. The `guard-frozen` hook blocks
  edits on any other branch.
- Types come from the schemas with `z.infer`. Never write a type by hand next to a schema.
- A new field on a stored shape must be optional. Saved `run.json` files, recorded eval weeks and
  old drafts must still parse. Examples: `DigestItem.urgency` and `action` (a draft from before W8
  reads as `worth-a-look`), `RunRecord.sampling`, `counts.afterProcess` and `deliveredTo`.
- Keep a type here only if several features use it. A type with one owner goes in that feature.
  `Role` (five roles: `classify`, `guardPolicy`, `guardRisk`, `write`, `judge`) is in
  `models/roles.ts`: code asks for a role, a profile maps it to a model tag.
- `Item` text fields are untrusted web content. Do not treat them as safe because they parsed.
- Week ids follow `WEEK_ID_PATTERN` (`2026-W43`, weeks 01 to 53). `RunRecord.runId` is the week id.
- `RunRecord` embeds `GuardCheckId`, `JudgeScore` and `DeliveryId`, so `store/runRecord.ts` imports
  those feature files. That is allowed (type-only direction: store reads guards, select, delivery).
- `DigestSchema` only asks for at least one item. The 3 to 5 item rule lives in
  `checks/formatCheck.ts`, not here, so recorded digests still parse.
- `DigestItem.action` is capped at 200 characters. The word limits are the format check's job.
- `exitCodeFor` is a switch with no default branch. A new `RunStatus` fails the typecheck until
  it is mapped: `sent`, `dry-run` and `skipped` give 0, `failed` 1, `blocked` 2, `quiet` 3.
- `GuardCheckIdSchema` (`guards/guardVerdict.ts`) names guards only. `linkCheck` and `formatCheck` are not guards, so they
  appear in `rejectedBy` as plain strings. Guards can be switched off. The two checks cannot.
- Dates are ISO strings with an offset (`z.iso.datetime({ offset: true })`). URLs use `z.url()`.
- This file imports `zod` and nothing else. Keep it that way.

## Files

| File              | Role                                                                       |
| ----------------- | -------------------------------------------------------------------------- |
| `schemas.ts`      | The shared schemas and types, `WEEK_ID_PATTERN`, `ExitCode`, `exitCodeFor` |
| `schemas.test.ts` | Exit code mapping, builders parse, bad week id                             |

## Depends on, used by

Depends on: `zod` only.
Used by: almost every folder in `src/`, plus `evals/` and the shared test kit (`test/builders.ts`,
`test/fakes/`). The feature-owned type files import from here (`classification.ts` needs `Item`,
`runRecord.ts` needs `StepName`, `RunStatus`, `WeekId`).

## Change it safely

- Run `src/domain/schemas.test.ts`, then `pnpm check`. A change here can break files far away, so
  the typecheck matters more than the unit test.
- `test/builders.ts` must still build valid objects. Update it in the same change. The run-record
  parse cases (old records without `sampling`, `afterProcess`, `fallback`) are in
  `store/runRecord.test.ts`.
- Adding a required field breaks saved runs, eval fixtures and test fixtures. Make it optional
  and write the default for old data in a comment, as `urgency` does.
- Do not rename an enum value. Stored files and prompts use the old string.
- Do not add imports from other `src/` folders. This is the bottom of the dependency graph.
