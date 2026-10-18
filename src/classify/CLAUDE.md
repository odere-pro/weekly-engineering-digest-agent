# Classify

## Intent

The digest can only carry 3-5 items, so every item that passed the input guards needs a score.
This step gives each item four numbers: how relevant it is (0 to 3), which focus area it
belongs to, how likely it is hype, and how likely it is a minor release. It drops nothing. The
process step applies the thresholds later.

## How it works

1. `classifyStep(items, deps)` (`classify.ts`) returns `[]` for no items, with no model call.
2. In the default decide mode, `classifyEach` makes one `model.decide` call per item, one at a
   time, with role `classify`. The state comes from `classifyState(item, areaHint)`: the data
   rule, an optional `Source tag:` line, then the item as an untrusted block.
3. The four questions come from `classifyQuestions(focusAreas)`: `relevance` (score, the four
   `RELEVANCE_LEVELS`), `area` (choice: the focus areas plus `other`), `hype` and `minorRelease`
   (yes/no). The ids are in `QUESTION_IDS`.
4. `fromAnswers` maps the answers to a `Classification`: relevance is the expected level,
   `areaConfidence` is the choice confidence, hype and minorRelease are the yes probabilities.
   `ClassificationSchema` validates it.
5. Generate mode (`deps.mode = 'generate'`) is a fallback. `classifyInBatches` asks for JSON in
   batches of 10 through `generateStructured` (role `classify`, temperature 0), with ids and
   areas as enums. Items the model left out are retried once in their own batches. Items still
   missing become `notRelevant` (relevance 0, area `other`) and log a warning.
6. Optional rescoring (`rescoreWithWriter` with `minRelevance`): items at or above `minRelevance`
   go to the writer model (role `write`) in batches of 10. Its relevance replaces the decider's.
   Its area replaces the decider's only when it answers confidence `high`. Hype and minorRelease
   stay. A failed batch keeps the decider's scores.
7. The result is `ScoredItem[]` in input order. `areaHintsOf(sources)` builds the hints.

## Design

- In decide mode a missing, wrongly typed or out-of-range answer, or an area that is not an
  option, throws a `DigestError` for step `classify`. It never defaults silently.
- Every prompt that embeds item text uses `wrapUntrusted()` and `UNTRUSTED_DATA_RULE`. The area
  hint comes from config, not from the web. `tagText` still flattens it to one line, so line
  breaks cannot add instructions. It sits outside the data block. A blank hint means no hint.
- Ask for a role, never a model tag. Decide calls run one at a time because the endpoint takes
  one state per call.
- `areaOptions` removes duplicate focus areas and adds `other` unless a focus area already
  uses that name.
- Wiring today: `runDigest` passes only `model`, `focusAreas`, `logger` and `areaHints`. So a
  real run always uses decide mode and never rescores, even though `config.models.rescoreWithWriter`
  exists. Only `evals/rescoreReplay.ts` turns rescoring on. Generate mode runs in tests only.
- Inputs are not mutated. Results are new objects.

## Files

| File                     | Role                                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------------------- |
| `classify.ts`            | `classifyStep`, `areaHintsOf`, decide mode, generate mode, rescoring                           |
| `classifyPrompt.ts`      | Questions, states and prompts; `OTHER_AREA`, `RELEVANCE_LEVELS`, `QUESTION_IDS`, `areaOptions` |
| `classify.test.ts`       | Decide mode, generate mode, area hints, rescoring                                              |
| `classifyPrompt.test.ts` | State and prompt layout, hints, rescore prompts                                                |

There is no `__fixtures__/` here. Tests use `FakeModelProvider` from `test/fakes`.

## Depends on, used by

Depends on: `domain` (schemas), `models` (`ModelProvider`, `generateStructured`), `shared`
(`untrusted`, `errors`, `telemetry`).
Used by: `digest/runDigest.ts` (`classifyStep`, `areaHintsOf`); `evals/` (`runEval`,
`rescoreReplay`, `thresholds/capture`, the classifier cases); `QUESTION_IDS` is also used by
the digest and integration tests to script a fake model.

## Change it safely

- Run `pnpm vitest run src/classify`. Coverage:
  `pnpm vitest run --coverage --coverage.include='src/classify/classify.ts'`.
- Do not rename `QUESTION_IDS`. The digest and `test/integration` tests build fake answers with them.
- Changing a question, level text or prompt changes what the classifier scores. Check the
  classifier cases in `evals/` before and after.
- Keep the no-hint prompt byte-identical to the old one. A test checks it.
- This step must not import adapters or `node:fs`. Do not call `fetch` for a model.
