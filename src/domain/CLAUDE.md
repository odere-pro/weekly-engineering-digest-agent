# Domain schemas

## Intent

One file holds the zod schemas and the TypeScript types that every step, port and adapter share:
sources, items, classifications, digests, drafts, judge scores, guard verdicts and the run record.
Having one definition keeps parallel workers from drifting apart. It also holds the run status and
the exit codes, so the CLI and the scheduler agree on what a run result means.

## How it works

This folder has no flow of its own. It describes the data that moves through the pipeline:

1. A `Source` (an allowlisted feed) gives `Item`s. `Item.id` is the hash of the normalized URL.
2. `classify` adds a `Classification`. An item plus its classification is a `ScoredItem`.
3. Each writer turns the top items into a `Digest` (made of `DigestItem`s). A `Draft` is one
   digest plus the writer tag.
4. Guards return `GuardVerdict`s. The judge returns a `JudgeScore`. Both end up in a
   `DraftOutcome`, with the ids that rejected the draft in `rejectedBy`.
5. The run ends as a `RunRecord`. `exitCodeFor(status)` turns its `RunStatus` into an `ExitCode`.

## Design

- Frozen file. Change it on `main` only, then rebase open branches. The `guard-frozen` hook blocks
  edits on any other branch.
- Types come from the schemas with `z.infer`. Never write a type by hand next to a schema.
- A new field on a stored shape must be optional. Saved `run.json` files, recorded eval weeks and
  old drafts must still parse. Examples: `DigestItem.urgency` and `action` (a draft from before W8
  reads as `worth-a-look`), `RunRecord.sampling`, `counts.afterProcess` and `deliveredTo`.
- `RoleSchema` lists the five model roles: `classify`, `guardPolicy`, `guardRisk`, `write`,
  `judge`. Code asks for a role. A profile maps the role to a model tag.
- `Item` text fields are untrusted web content. Do not treat them as safe because they parsed.
- Week ids follow `WEEK_ID_PATTERN` (`2026-W43`, weeks 01 to 53). `RunRecord.runId` is the week id.
- `DigestSchema` only asks for at least one item. The 3 to 5 item rule lives in
  `checks/formatCheck.ts`, not here, so recorded digests still parse.
- `DigestItem.action` is capped at 200 characters. The word limits are the format check's job.
- `exitCodeFor` is a switch with no default branch. A new `RunStatus` fails the typecheck until
  it is mapped: `sent`, `dry-run` and `skipped` give 0, `failed` 1, `blocked` 2, `quiet` 3.
- `GuardCheckIdSchema` names guards only. `linkCheck` and `formatCheck` are not guards, so they
  appear in `rejectedBy` as plain strings. Guards can be switched off. The two checks cannot.
- Dates are ISO strings with an offset (`z.iso.datetime({ offset: true })`). URLs use `z.url()`.
- This file imports `zod` and nothing else. Keep it that way.

## Files

| File              | Role                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| `schemas.ts`      | All schemas and inferred types, `WEEK_ID_PATTERN`, `ExitCode`, `exitCodeFor`                     |
| `schemas.test.ts` | Exit code mapping, builders parse, old records without `sampling` or `afterProcess`, bad week id |

## Depends on, used by

Depends on: `zod` only.
Used by: almost every folder in `src/` (all pipeline features, the five ports, adapters, `config`,
`cli`, `app`, `store`), plus `evals/` and the shared test kit (`test/builders.ts`, `test/fakes/`).

## Change it safely

- Run `src/domain/schemas.test.ts`, then `pnpm check`. A change here can break files far away, so
  the typecheck matters more than the unit test.
- `test/builders.ts` must still build valid objects. Update it in the same change.
- Adding a required field breaks saved runs, eval fixtures and test fixtures. Make it optional
  and write the default for old data in a comment, as `urgency` does.
- Do not rename an enum value. Stored files and prompts use the old string.
- Do not add imports from other `src/` folders. This is the bottom of the dependency graph.
