# Select the winning draft

## Intent

Each writer in the panel produces one draft. After the checks and the output guards, more than one
draft can be left. This step picks the one that goes out. A judge model scores each passing draft
against its own source items, and the best mean score wins. If the judge cannot decide, the run
still goes on with a fixed, predictable choice.

## How it works

1. `selectStep(drafts, sources, deps)` gets the drafts that passed and the collected items. No
   draft: it throws a `DigestError` (exit code Blocked, step `select`). One draft: it returns it
   with `judged: false` and makes no judge call.
2. `prepareJudgeCalls` finds the sources each draft cites with `resolveDraftSources` (each once,
   in digest order) and logs a warning for cited ids that were not collected. `buildJudgeState`
   writes the judge's input: `UNTRUSTED_DATA_RULE`, one instruction line, the draft as
   `canonicalDigestText` in a `draft` data block, and each source in its own `source:<id>` block.
3. `buildJudgeQuestions(focusAreas)` makes four 5-level score questions: `accuracy`, `clarity`,
   `whyItMatters`, `focusFit`. Every draft gets the same words.
4. `judgeOneByOne` calls `model.decide({ role: 'judge', state, questions })` once per draft, in
   turn. `toJudgeScore` turns each answer (a 0-based level) into a 1-5 rating and takes the mean.
5. `pickWinner` takes the highest overall score. A tie goes to the writer listed first in
   `writerOrder`. Writers missing from that list rank last, in arrival order.
6. Output is `{ winner, scores, judged }`. If the judge throws or gives an unusable answer,
   `fallBackToWriterOrder` returns the first draft in writer order, with no scores, `judged: false`
   and a warning.

## Design

- One call per draft. The judge sees one draft and only its own sources, never another draft and
  never the writer's name. No score can leak from, or be pulled by, a neighbour.
- Draft and sources are untrusted. They are wrapped with `wrapUntrusted`, and the data rule is in
  the input. The `decide` role is `judge`; architecture rules allow `decide` for the judge.
- The judge reads canonical plain text (`render/canonical.ts`), not Markdown. A new layout does
  not move scores, so eval baselines stay comparable.
- A judge failure never fails the run (F33). A bug while building the judge input (before the
  `try`) does fail loudly, so it is not hidden as an outage.
- `toJudgeScore` throws a `DigestError` for step `select` when a criterion has no `score` answer
  or a non-finite level. A level outside the rubric is clamped to 1-5. It is exported so
  `evals/judge/evalJudge.ts` converts answers in exactly the same way.
- Scores within `SCORE_TIE_EPSILON` (1e-9) are a tie. This absorbs floating-point noise.
- Logs hold the writer tag and the score, never draft text. A judge error is cut to 300 characters.
- Inputs are not changed. `runDigest` finds the winner by object identity, so `winner` must be
  one of the `Draft` objects it was given, not a copy.

## Files

| File             | Role                                                                                                                         |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `select.ts`      | `selectStep`, `toJudgeScore`, tie-break and fallback, `SelectDeps`, `SelectOutput`                                           |
| `judgePrompt.ts` | `JUDGE_CRITERIA`, `JUDGE_LEVELS`, `buildJudgeQuestions`, `buildJudgeState`, `resolveDraftSources`                            |
| `*.test.ts`      | `select.test.ts` (counts, one call per draft, scoring, ties, fallback), `select.toJudgeScore.test.ts`, `judgePrompt.test.ts` |

## Depends on, used by

Depends on: `domain` (types, `ExitCode`), `models` (`ModelProvider` types), `render/canonical`,
`shared` (errors, telemetry, text, untrusted).
Used by: `digest/runDigest.ts` (`selectStep`, only when the profile has a judge and two or more
drafts passed), `evals/judge/evalJudge.ts` (`toJudgeScore`), `test/integration/harness.ts`
(`JUDGE_CRITERIA`).

## Change it safely

- Tests use `FakeModelProvider` from `test/fakes` with scripted `decide` answers. Run
  `src/select/` first, then `evals/judge/evalJudge.test.ts`.
- `JUDGE_CRITERIA` are the keys of `JudgeScore.byCriterion`. Changing a name, a question or a
  level moves every score. Re-check the eval judge (`evals/judge/calibrate.ts`) afterwards.
- Never put two drafts, a writer tag or a raw source outside `wrapUntrusted` into the judge input.
- Keep the judge calls in turn. Do not use `Promise.all` over drafts.
- Do not move `prepareJudgeCalls` inside the `try`. It would turn a code bug into a quiet fallback.
