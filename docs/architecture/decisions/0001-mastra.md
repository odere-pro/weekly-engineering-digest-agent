# 0001. Remove Mastra and keep plain steps behind ports

- Status: accepted (2026-10-19)
- Date: 2026-10-18
- Decides: whether to use `@mastra/core` fully or remove it
- Recommendation: **remove it** (option B)
- Maintainer, 2026-10-19: accepted. Mastra is removed (issues 1 to 4 below, done together).

## Context

The spec named Mastra for the workflow. The build kept it to a thin wrapper so the pipeline stays
plain, testable functions behind ports (see `.claude/rules/architecture.md`). Today `@mastra/core`
1.78.0 is used in one file, `src/digest/workflow.ts` (54 lines). `runDigest.ts` calls it once to
run 8 step functions in order. It uses one Mastra feature: a linear workflow with opaque state.

The maintainer's rule: a framework should be used as fully as possible, or not at all when it
serves one or two features. This record tests that rule with numbers.

What the wrapper costs now (measured 2026-10-18 and 2026-10-19 on a busy machine):

- Install: `@mastra/core` brings 124 packages that nothing else uses and takes 82 MB.
- Start: importing `@mastra/core/workflows` takes 460 to 970 ms and raises memory from 49 MB to
  195 MB. `digest --help` has a median of 940 ms with Mastra and 389 ms with a plain loop in its
  place (12 runs each, same bundle otherwise). A second run at load average 65 gave 1,309 vs
  619 ms wall time and 820 vs 400 ms CPU time (15 runs each, interleaved). CPU time is the steadier
  number: Mastra adds about 0.4 s.
- Upkeep: the code calls the internal `__setLogger` and rethrows errors by hand (see below). Both
  need a re-check whenever the pin moves.
- Reach: `@mastra/core` depends on `posthog-node` and has a telemetry client (default on, off with
  `MASTRA_TELEMETRY_DISABLED`). Our rule 4 allows only feed hosts, Ollama and the delivery endpoint.
  I ran a workflow with telemetry left on, once as we use it and once through `new Mastra(...)`,
  with `fetch`, DNS lookups and socket connects recorded and refused. Neither made any attempt in
  4 seconds. So today nothing leaves the machine, but option A would add a client that can.

## Options

**A. Use Mastra as fully as it fits.** A typed workflow (zod schemas per step, `retries`,
`foreach` for the writer panel, suspend/resume with stored snapshots), a `Mastra` instance with
libSQL storage, Mastra schedules for `digest serve`, scorers and datasets for `digest eval`,
input/output processors for the guards, Mastra observability, and the AI SDK Ollama provider for
the writer.

**B. Remove Mastra.** Replace `runWorkflow` with a plain loop over the same `WorkflowStep` list and
drop the dependency. Steps, ports and tests stay as they are.

Keeping the thin wrapper (today) is not a third option. It pays the full cost above for none of the
framework's features, which is the case the maintainer's rule rules out.

## Evidence

Method: counted our code in this checkout; read `node_modules/@mastra/core` (source and the docs
bundled with 1.78.0 under `dist/docs/references`); read Mastra's Ollama page and npm metadata; ran a
throwaway spike against the installed package (typed steps, retries, `foreach`, suspend/resume),
deleted afterwards. The extra packages for option A were not installed; their size comes from npm
metadata (unpacked, before their own dependencies): `@mastra/libsql` 4.1 MB, `@mastra/evals` 1.8 MB,
`@mastra/observability` 4.0 MB, `@mastra/otel-exporter` 0.3 MB, `ollama-ai-provider-v2` 0.4 MB,
`ai` 8.2 MB, and `@libsql/client` plus the native `libsql` build 8.0 MB. That is about 27 MB on top
of the 82 MB. "Lines removed" is the most our code could shrink, not a promise. Numbers marked
"est." or "about" are estimates.

| Candidate                     | Our code it could replace                                   | Lines removed | Added deps, storage                                    | Lost behaviour                                                    | Test impact                                    |
| ----------------------------- | ----------------------------------------------------------- | ------------- | ------------------------------------------------------ | ----------------------------------------------------------------- | ---------------------------------------------- |
| 1a Typed steps, retries, loop | writer loop in `write.ts`                                   | about 4       | zod schemas for `ChainState` (est. +60 to +90 lines)   | error class on rethrow; retry does not fit our retries            | `workflow.test.ts` stays; no step test changes |
| 1b Suspend/resume             | `runResume.ts` (238, now `digest/resume/resumeDelivery.ts`) | 0 to 10       | `@mastra/libsql`, `@libsql/client`, native `libsql`    | week-keyed resume without a model call and the link match check   | new storage fixtures; resume tests stay        |
| 2 Model calls (AI SDK)        | `generate` path in `ollama.ts` (est. 70 to 120)             | 70 to 120     | `ollama-ai-provider-v2`, `ai` ^7                       | timeouts, keep-alive, header-wait rules unless re-built           | new fakes for a second model path              |
| 2b `/v1/systemone`            | `systemone.ts` (226) and `decide`                           | 0             | none exist                                             | stays on our adapter: classify, both clef guards, judge           | none                                           |
| 3 Scorers and datasets        | `evals/metrics.ts` (706), `runEval.ts` (863)                | 0             | `@mastra/evals` (peer `vitest <5`, repo has 5.0.5), DB | git-reviewed frozen data; offline gates and exit codes            | metrics tests stay, scorer wrappers added      |
| 4 Schedules                   | cron wiring in `scheduler.ts` (582)                         | about 25      | `Mastra` instance, storage with a `schedules` table    | catch-up, lock-race retry, failed-tick retry, give-up note, limit | scheduler tests stay or are rewritten          |
| 5 Processors                  | `guards/` (clef 104, questions 138, run 184)                | 0             | an `Agent` per guard call                              | calibrated probabilities, tuned 0.35 threshold, fail closed       | guard tests and eval thresholds redone         |
| 6 Observability               | `tracedModel.ts` (63); `tracing.ts` (185)                   | 0 to 63       | `@mastra/observability`, `@mastra/otel-exporter`       | spans on every model call at the port; redaction proof            | `tracing` and `redact` tests redone            |

Option A total: at most about 220 lines out of 16,270 non-test lines in `src` (1.4%), against about 150 new
lines (est.) and 6 new direct packages (about 27 MB) plus a database file. Option B removes 54 lines
of `workflow.ts` and adds about 12, and removes 124 packages.

### Findings behind the table

**1a Typed steps, retries, foreach.** The spike ran a step that always throws, with `retries: 2`:
it ran 3 times, as documented. The thrown error came back as a plain `Object`. It kept its own
fields (`name`, `exitCode`) but lost its class, so `instanceof DigestError` fails. That is why
`workflow.ts` records the error in a closure and rethrows it. Typed steps would keep that
workaround. Mastra `retries` repeats the same step with the same input. Our writer retry is a
different call (the prompt plus what the checks found), and the model retry lives in the Ollama
adapter next to its timeouts. `foreach` with `concurrency` 1 ran a, bad, c strictly one after
another; with 3 they ran together. We need one at a time (`OLLAMA_MAX_LOADED_MODELS=1`), so the
parallel mode gives nothing. `CheckedDraft`, `CodeChecked`, `HeldArtifact`, `Settled` and `Failure`
are interfaces today, not zod schemas, so typed steps mean writing them.

**1b Suspend/resume.** On a bare workflow, `resume` fails with "No snapshot found for this workflow
run". With `new Mastra()` and its default in-memory storage, a fresh run object with the same
`runId` resumed, but only inside the same process. A restart needs `@mastra/libsql` (docs). Our
resume is different work: it never re-enters the chain. It sends the saved `digest.md` to the
channels that missed it, calls no model, and refuses when the links differ from `sentUrls`. A
snapshot table would be a second source of truth beside `RunRecord`. The 238 lines are delivery
rules, so none of them go away.

**2 Model calls.** Mastra's model router lists only `ollama-cloud` (`https://ollama.com/v1`). For
local Ollama, Mastra's own page says to install `ollama-ai-provider-v2` (4.0.1; peer `ai` ^7).
Nothing in `@mastra/core` (source or docs: zero matches for `systemone`) or in the AI SDK Ollama
providers speaks `/v1/systemone`. So `decide` stays on our adapter, and with it the
`ModelProvider` port, `tracedModel` and the Ollama fixtures. Only the writer and Granite
(`generate`) could move. Then we would run two paths to Ollama with two retry, timeout and log
rules. Its README (read second-hand) documents `think` (`providerOptions.ollama.think`), `seed` and
`num_ctx` (`providerOptions.ollama.options`). It does not mention `keep_alive`, a request timeout
or an abort signal. Not verified in its code: the 600 s writer timeout and the header-wait rule.

**3 Scorers and datasets.** Scorers grade an agent's or a step's output. Our 16 measurements are
pure functions over run records and replays, so wrapping them removes nothing. `@mastra/evals`
1.10.7 peers `vitest >=3 <5` and the repo runs 5.0.5. Datasets and experiments need a storage
adapter with a `datasets` domain (docs). Our eval data is frozen JSON in git, with held-out cases.

**4 Schedules.** Mastra fires a workflow's `schedule` from a polling loop over a schedules table.
That needs a `Mastra` instance and a storage adapter with the schedules domain, and a long-lived
process (we already have `digest serve`). It uses croner, as we do. The docs describe no catch-up:
resuming a paused schedule does not backfill, and the harness page says a fire missed while the
machine slept is skipped. They describe no lock-race retry, no failed-run retry policy, no give-up
note and no run time limit. `src/scheduler/CLAUDE.md` gives these as why it exists.

**5 Processors.** Processors hang off an `Agent` (`inputProcessors`). `PromptInjectionDetector`
asks a model for JSON where each category has a self-reported `score` between 0 and 1
(`agent-Blan8B5o.js`, class at line 14858), then compares it with `threshold` (default 0.7).
Our clef guard reads the real probability of "yes" from the decision endpoint
(see the recorded answer in `systemone-clef.json`) and flags above `guardFlag` 0.35, which `tuneThresholds.ts` sets from
labeled cases. A model's stated confidence is not that number. The detector also fails open by
default (`errorStrategy: 'warn'`); ours fails closed. Calibrated probabilities and thresholds must
stay, so none of `guards/` goes.

**6 Observability.** Our `Tracer` port is already OpenTelemetry. `tracedModel` puts a span on every
`generate` and `decide` at the port, and `redact.ts` keeps secrets out of spans (security rule 5).
Mastra spans cover Mastra-run workflows and agents only, and its OTel bridge is marked
experimental. We would add two packages and still keep `redact.ts`.

## Decision

Remove Mastra (option B).

- By the maintainer's rule, using it fully removes about 1.4% of our code and takes away three
  things we need (calibrated guard probabilities, the decision endpoint, scheduler catch-up and
  retry) and keeps the error workaround. That is not "fully used"; it is a worse fit.
- The product is a fixed pipeline whose models have no tools or network (security rule 1). Mastra's
  weight is agents, tools, memory and a server. This pipeline uses none of them by design.
- The one feature we use is an 8-line loop. The port design already keeps the pipeline free of any
  vendor, so removing Mastra changes one file.

## Consequences

Good:

- 124 fewer packages, 82 MB less install, about 0.4 s less CPU time on every CLI start and about 146 MB
  less memory at import (measured above).
- One less pinned vendor, no internal `__setLogger` call, and no telemetry client in the tree.
- The error rethrow workaround and its console test go away: a plain loop keeps the error as is.

Bad or neutral:

- We lose Studio, graph view, time travel and step status for free. We never used them.
- We write the sequencing ourselves (a loop over `WorkflowStep`). If the chain grows branches or
  waits, we own that code.
- The spec names Mastra. The coordinator should note the deviation in `docs/plan/spec.md`.
- Docs and comments that name Mastra must change (see issue 3).

Revisit and write ADR 0002 if one of these becomes true. Then use Mastra fully, not thinly.

- A step must wait days for a person's approval before it sends.
- The pipeline gets long-lived branching or fan-out that needs stored snapshots.
- We add agents with tools to the product, which would change the security invariants first.
- Mastra supports local Ollama and a decision endpoint for guards and judges.

## Removal plan (issues for the wave 10 coordinator)

Package files are frozen on branches, so issue 2 is for the coordinator on `main`.

1. **Plain loop for the chain.** Lane `cpu`. Owns `src/digest/workflow.ts` and
   `src/digest/workflow.test.ts`. Test first: keep the tests for order, empty list, state handed
   over as is, the very same error rethrown, and concurrent runs. Delete the console test (nothing
   logs now). Replace the body with `for (const step of steps) state = await step.run(state);`.
   Keep the `WorkflowStep` type and the `runWorkflow` signature so `runDigest.ts` does not change.
   Done when `pnpm check` is green.
2. **Drop the dependency.** Lane `cpu`, coordinator on `main`. Remove `@mastra/core` from
   `package.json` and `pnpm-lock.yaml`. Done when `pnpm why @mastra/core` finds nothing and
   `pnpm check` and `pnpm build` pass. Record the new `node_modules` size and `digest --help` time.
3. **Docs and comments.** Lane `research`. Update `.claude/rules/architecture.md` (line 42),
   `src/digest/CLAUDE.md` (design bullet, files table, tests list), `docs/how-it-works.md`
   (since replaced by `docs/architecture/`), the comments in `test/integration/dryRun.test.ts` and
   `harness.ts`, and add a `CHANGELOG.md` entry. Leave the old entry at line 75, it is history.
4. **Keep it out.** Lane `cpu`, coordinator. Add `@mastra/*` to the `no-restricted-imports` list in
   the ESLint config with a message that points to this record, so a return needs ADR 0002.

If the maintainer picks A instead, plan it in this order and re-measure after each step:
typed `ChainState` schemas, then a `Mastra` instance with libSQL (and telemetry off), then
the writer through the AI SDK provider, then schedules, scorers and observability last. Expect
guards and `decide` to stay on our code.
