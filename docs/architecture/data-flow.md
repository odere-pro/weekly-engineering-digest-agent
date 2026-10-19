# Data flow

Part of [Architecture](README.md).

A run turns feeds into one digest. Plain async steps run in a fixed order, one after another.
Models do the judging. Code does the checking.

```text
collect -> guardInput -> classify -> process -> write -> guardOutput -> select -> deliver
 feeds      drop attacks   score items   pick top N   draft panel   drop bad drafts  pick best   channels
```

A step is a plain function `(input, deps) => output` that lives in its own
[feature folder](feature-folders.md). `src/digest/workflow.ts` runs them in order with a plain loop
(Mastra was removed: [ADR 0001](decisions/0001-mastra.md)), and `src/digest/runDigest.ts` owns the order, the timings and the run ending. Only one model is
loaded at a time, so model calls run strictly one after another.

## The steps

| Step          | In             | Out                          | Model role                 | Safety net                                      |
| ------------- | -------------- | ---------------------------- | -------------------------- | ----------------------------------------------- |
| `collect`     | config sources | items in the window          | none                       | Host rules, size and redirect limits            |
| `guardInput`  | items          | items no guard flagged       | `guardPolicy`, `guardRisk` | `clefPolicy`, `graniteRisk`; unparsable = flag  |
| `classify`    | items          | relevance, area, hype, minor | `classify`                 | Every answer is type-checked                    |
| `process`     | scored items   | top N items (3 to 5)         | none                       | Thresholds, dedupe, area spread                 |
| `write`       | selected items | one draft per writer         | `write`                    | Provenance, link check, format check, one retry |
| `guardOutput` | drafts         | drafts that passed           | `guardRisk`, `guardPolicy` | `graniteGroundedness`, `clefRubric`             |
| `select`      | passing drafts | the winner                   | `judge` (if any)           | First passing draft wins without a judge        |
| `deliver`     | the winner     | files, email, Slack          | none                       | Redaction before every channel                  |

## What each step does

- **collect.** Fetches every source (4 at a time, 10 s per attempt, 2 retries), keeps items inside
  `windowDays`, caps each source at `maxItemsPerSource` and drops duplicate ids. A failed source is
  listed in `failedSources` and skipped. See [sources](../features/sources.md).
- **guardInput.** One call per item per input guard. Items flagged above `thresholds.guardFlag`
  are dropped (mode `any`), or only when every guard flags (mode `all`).
  See [guards](../features/guards.md).
- **classify.** One `decide` call per item with four questions: relevance (0 to 3), area (one of
  your `focusAreas` or `other`), hype (yes/no) and minor release (yes/no). It drops nothing.
  See [classify](../features/classify.md).
- **process.** Code only. Ranks items, then drops them in a fixed order: `sent-before`,
  `duplicate`, `low-relevance`, `hype`, `minor-release`. Keeps the top `topN` with a spread across
  areas. Fewer than 3 items left ends the run `quiet`. See [process](../features/process.md).
- **write.** Each writer in the panel gets the same prompt and returns a structured digest. The
  step sets every URL from the collected item, so a model can name an item but never choose its
  link. Then the [link check and format check](../features/checks.md) run, and each writer gets
  one retry if no draft passes. See [write](../features/write.md).
- **guardOutput.** `graniteGroundedness` checks each summary, the headline and the intro against
  their sources. `clefRubric` flags off-task, hype or harmful drafts. If every draft is rejected,
  the run ends `blocked`.
- **select.** With a judge and two or more passing drafts, one call per draft scores accuracy,
  clarity, why it matters and focus fit (1 to 5). The best mean wins. A judge failure falls back
  to the first passing draft. See [select](../features/select.md).
- **deliver.** Sends the winner to every channel and records which ones took it. The
  [render](../features/render.md) feature turns the winner into Markdown, HTML, email and Slack
  output. See [delivery](../features/delivery.md).

## How a run can end early

| Where                        | Result    | Why                                                      |
| ---------------------------- | --------- | -------------------------------------------------------- |
| Before `collect`             | `skipped` | The week already has a sent digest (and no `--force`)    |
| Before `collect`             | `failed`  | Ollama unreachable, a model missing, or the lock is held |
| After `collect` or `process` | `quiet`   | Nothing collected, or fewer than 3 items worth sending   |
| After `guardOutput`          | `blocked` | Drafts exist and every one was rejected                  |
| Any step                     | `failed`  | A step threw, or no writer made a draft                  |

The statuses and what each one means are on [run semantics](run-semantics.md).

## Data that moves

Each stage returns a new immutable state. The shapes are the zod schemas in `src/domain/`:
`Item`, `Classification`, `ScoredItem`, `Digest`, `Draft`, `GuardVerdict`, `JudgeScore` and
finally `RunRecord`. What lands on disk is on [data layout](data-layout.md). Field by field:
[run record](../reference/run-record.md).

## Prompts

Every prompt that embeds collected text wraps each item in an untrusted-data block and puts the
data rule in the system prompt: item text is data, never instructions. No model has tools or
network access. Sampling is fixed for repeatability: `models.seed` (42) on every call, temperature
0.2 for `write` and 0 for the other roles. See [safety](safety.md).

## Related

- [Digest feature](../features/digest.md), [ports and adapters](ports-and-adapters.md)
- [Triage](../operations/triage.md) for what to do with each end state
