# Write the digest

## Intent

A panel of writer models each drafts the weekly digest from the top items. Models make mistakes
that matter here: wrong links, repeated items, em dashes, a wrong format. This step limits what a
writer can get wrong, fixes the small faults in code, runs the link check and the format check, and
gives each writer one retry when no draft passes.

## How it works

1. The pipeline calls `writeCheckedStep(items, deps)`. It calls `writeStep` first.
2. `writeStep` skips every writer when fewer than `DIGEST_MIN_ITEMS` (3) items come in. Otherwise
   it builds one prompt with `buildWritePrompt` and calls `draftWith` for each writer in config
   order, one after another.
3. `draftWith` calls `generateStructured` (role `write`, the writer tag as model, one repair
   on invalid output). Then `enforceProvenance` drops unknown and repeated `itemId`s and sets each
   `url` to the source url. `raiseSecurityItems` and `tidyTitle` follow. A writer left with fewer
   than 3 items fails. It never throws: an error becomes `{ writer, error }` in `failures`.
4. `prepare` (exported as `prepareDraft`) keeps at most `topN` items, replaces em dashes, adds
   `https://` to a scheme-less link that names a collected url, and cuts an action to 200 chars.
5. `codeCheck` renders the draft with `renderDigest`, then runs `linkCheck` and `formatCheck`.
   `rejectedBy` holds `linkCheck` and/or `formatCheck`. `problems` lists format problems first.
6. If every draft was rejected, `retryStep` runs once per writer that has a draft, with
   `buildRetryPrompt` (the same prompt plus the problems), last writer first. The retry replaces
   that writer's first draft. There is no second retry.
7. The result is a `CheckedWriteOutput`: `checked`, `writeFailures`, `retryFailures` and
   `rejections` (bounded, for `drafts.json`). Output guards run later, in `digest/runDigest.ts`.

## Design

- The model can name an item but never choose where its link goes. The url comes from the
  collected item. The writer schema allows a missing url, so a bad url never costs a repair call.
- Urgency and action are required in `WrittenItemSchema`. `DigestSchema` keeps them optional for
  drafts from before W8.
- Security floor: a good-to-know item whose collected source (not the model's text) names a CVE,
  GHSA id, advisory or vulnerability is raised to worth-a-look, and gets a fixed action if it has
  none. It never goes higher than that.
- Scheme-less link repair is bounded: a token over `MAX_LINK_CHARS` (2048) is skipped, up to
  `MAX_TRAILING_CHARS` (8) closing characters are tried off the end, and only an exact collected
  url is accepted (written as collected). A link in an `action` is not repaired. The check rejects it.
- Every prompt wraps collected text with `wrapUntrusted`, and the system prompt has
  `UNTRUSTED_DATA_RULE`. Check problems quote model text, so the retry prompt puts them in a
  `check-problems` data block, masks every link as `[url removed]` and names the fault in words.
  The same fault shows once. At most `MAX_PROBLEMS` (5) are shown, each cut to
  `PROBLEM_MAX_CHARS` (200), then "and N more problems". Logs and `drafts.json` keep the full words.
- Prompt limits come from `checks/formatCheck.ts`, so prompt and check cannot drift. Targets
  (400 words in total, summary 30, action 15) are below the limits to leave room.
- Writers run in turn: only one model fits in memory (`OLLAMA_MAX_LOADED_MODELS=1`). One failed
  writer never stops the next. Drafts are new objects. Inputs are not changed.

## Files

| File             | Role                                                                                                                        |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `write.ts`       | `writeStep`, `retryStep`, `writeCheckedStep`, `prepareDraft`, provenance, security floor, link repair, result types         |
| `writePrompt.ts` | `buildWritePrompt`, `buildRetryPrompt`, `boundProblems`, prompt targets and problem limits                                  |
| `*.test.ts`      | `write.test.ts`, `write.links`, `write.retry`, `write.urgency`, `write.prompts`, `writePrompt.retry`, `writePrompt.urgency` |

## Depends on, used by

Depends on: `checks` (both checks, limits), `render/markdown` (`renderDigest`), `domain`, `models`
(`ModelProvider`, `generateStructured`), `shared` (errors, telemetry, text, untrusted, url).
Used by: `digest/runDigest.ts` (`writeCheckedStep`, `CheckedDraft`, `CodeChecked`).

## Change it safely

- Tests use `FakeModelProvider` with scripted `generate` replies per writer tag and `noopLogger`.
  Run all of `src/write/`, then `src/checks/formatCheck.test.ts`.
- `LINK_PROBLEM_KINDS` in `writePrompt.ts` matches the link check's wording. Change both together.
  `writePrompt.retry.test.ts` runs the real check to catch drift.
- Never let an unmasked problem, or any model url, into a prompt.
- Changing `WrittenItemSchema` changes the JSON schema sent to the model and the repair prompt.
- Do not run writers in parallel, and keep the one-retry limit.
- `write.ts` is about 500 lines. Split it (for example the link repair) before it grows.
