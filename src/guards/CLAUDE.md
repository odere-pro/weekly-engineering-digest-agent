# Guards

## Intent

Collected text and model drafts are untrusted. Guards are the model-based safety checks. Input
guards look at each collected item before any other model sees it. Output guards look at each
draft. They catch prompt injection, harmful content, claims not found in the sources, off-task
text and hype. Config can switch a guard off. The link check and format check are not guards.
They live in `src/checks`, run in code, and cannot be switched off.

## How it works

1. The port (`Guard.ts`): `InputGuard.checkItem(item)` and `OutputGuard.checkDraft(draft, sources)`
   each return a `GuardVerdict` (`check`, `flagged`, optional `probability` and `reason`). The
   ids are `clefPolicy` and `graniteRisk` (input), `graniteGroundedness` and `clefRubric` (output).
2. `guardInputStep(items, deps)` and `guardOutputStep(drafts, sources, deps)` call
   `planGuards` (`guardRun.ts`). A check runs when its section and the check are on in config and
   a guard with that id was supplied. The order is the config order.
3. `applyGuards` runs the checks guard by guard: all subjects through guard A, then guard B, so
   only one guard model is loaded at a time. Mode `any`: a flag drops the subject at once and the
   next guard sees only unflagged ones. Mode `all`: only flagged subjects go on, and a subject is
   dropped only if the last guard flags it too. No active check keeps everything.
4. The steps return `kept`/`dropped` (input) or `passed`/`rejected` (output), with the verdicts of
   every guard that looked at the subject, plus `disabledChecks`. Both lists keep input order.
5. `createClefPolicyGuard` (input) and `createClefRubricGuard` (output, `adapters/clefPolicy.ts`)
   make one `decide` call with role `guardPolicy` and several yes/no questions from
   `guardQuestions.ts`. They flag when any P(yes) is above `flagThreshold` (`thresholds.guardFlag`,
   default 0.35). A value equal to the threshold does not flag.
6. `createGraniteRiskGuard` (input) asks `granite4.1-guardian` about `jailbreak`, then `harm`, and
   stops at the first yes. `createGraniteGroundednessGuard` (output) checks each digest item
   against its own source item, then the headline and intro against all cited sources.
   Both use `generate` (role `guardRisk`, temperature 0).

## Design

- Fail closed. Granite must answer exactly `<score>yes</score>` or `<score>no</score>` after the
  last `</think>` (`parseGraniteScore`). Anything else flags as `unparsable guard output`. A
  missing or malformed decide answer throws `DigestError`. A digest item with no source item flags.
- Guard errors propagate and fail the run. `mapBounded` starts no new call after a failure and
  throws the error of the earliest input.
- Prompts use `wrapUntrusted()` and `UNTRUSTED_DATA_RULE` (`guardState`, or the Granite system
  prompt). The item URL is shown to the guard, so a hidden instruction in it is judged too. The
  writer's name is never sent. States stay short because `strands-decider` has a 4K context.
- `GUARD_CONCURRENCY` is 1 on purpose. On 2026-10-17 limits 1, 2 and 4 all took about 112 s with
  the same verdicts. Raise it only after timing a server that runs requests in parallel.
- Granite criteria, except `headline`, are copied from the model's chat template. Do not reword
  them. `headline` is our own wording, because the generic one flagged editorial framing.
- Questions say that reporting on a security fix or vulnerability is not harmful. A test pins it.
- Logs hold ids, the writer and flagging check ids only, never item or digest text.
- A disabled or missing guard is not silent: it is in `disabledChecks`, the run record and the
  digest footer. A missing guard also logs a warning.

## Files

| File                                          | Role                                                                    |
| --------------------------------------------- | ----------------------------------------------------------------------- |
| `Guard.ts`                                    | The port: `InputGuard`, `OutputGuard`, `GuardCallOptions`               |
| `guardRun.ts`                                 | `planGuards`, `applyGuards`, `flaggedBy`, `GUARD_CONCURRENCY`           |
| `guardInput.ts`, `guardOutput.ts`             | `guardInputStep`, `guardOutputStep`                                     |
| `guardQuestions.ts`                           | Policy and rubric questions; `policyState`, `rubricState`, `guardState` |
| `adapters/clefPolicy.ts`                      | The two decision-model guards                                           |
| `adapters/granite.ts`                         | The two Granite guards, `GRANITE_CRITERIA`, `parseGraniteScore`         |
| `*.test.ts`, `adapters/__fixtures__/granite/` | Tests; 7 fixtures of replies recorded from `granite4.1-guardian:8b`     |

## Depends on, used by

Depends on: `domain`, `config/schema` (types), `models/ModelProvider` (types), `render/canonical`,
`shared`. Used by: `digest/runDigest.ts` (both steps, `planGuards`, `flaggedBy`),
`app/container.ts` (builds the adapters), `evals/` (`runEval`, thresholds), `test/fakes/FakeGuards`.

## Change it safely

- Tests: `guardRun.test.ts` (engine), `guardInput.test.ts` and `guardOutput.test.ts` (modes,
  disabled checks, logging), `guardQuestions.test.ts` (wording pinned), `adapters/*.test.ts`.
- `graniteRecorded.test.ts` replays the fixtures, which also store the prompts. If a prompt
  changes, the test fails until the replies are recorded again (live Ollama, one at a time).
- Changing a question or criterion changes verdicts. Re-check the thresholds with `evals/`.
- The steps do not pass an abort signal to the guards, though `GuardCallOptions.signal` exists.
- Never log or return model text, item text or draft text in a reason.
- The top-level files must not import `adapters/`, `node:fs` or `ollama`.
