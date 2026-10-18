# Models

## Intent

Every language-model call in the digest goes through one port, `ModelProvider`. The pipeline asks
for a role (classify, guardPolicy, guardRisk, write, judge), never for a model tag or a URL. This
keeps the steps free of any vendor, and the Ollama details (endpoints, timeouts, retries, context
limits) live in one adapter.

## How it works

1. A step builds a `GenerateRequest` (free text out) or a `DecideRequest` (typed questions about
   a text: `yesno`, `choice`, `score`) and calls `generate()` or `decide()` on the port.
2. Steps that need JSON call `generateStructured(model, request, zodSchema, step)`. It sends the
   JSON Schema, validates the reply, and on failure asks the same model once to repair it. A second
   failure throws a `DigestError` for that step.
3. `createOllamaProvider(options)` is the adapter. `resolveModel` picks the tag from the profile
   for the role (or the explicit `model` the write step passes).
4. `generate` posts to `/api/chat` (streamed NDJSON, joined by `joinChat`). `decide` posts to
   `/v1/systemone` after `validateQuestions`, `toSystemOneQuestions` and `fitState`, and maps the
   reply back with `parseSystemOneResponse`.
5. `callOllama` wraps every call: per-attempt timeout, retries with backoff, one log line.
   `health()` reads `/api/version` and `/api/tags` and never throws.

## Design

- The port owns the shapes (`DecisionQuestion`, `DecisionAnswer`, `ModelHealth`). The adapter maps
  them to Ollama, so another vendor means a new adapter and no step changes.
- `decide` is for classify, policy guards and the judge. `generate` is for writing and Granite.
- Timeouts per attempt: classify 60 s, guardPolicy 60 s, guardRisk 120 s, judge 120 s, write 600 s
  (`DEFAULT_TIMEOUTS_MS`, overridable by config).
- Retries: 2 by default (config allows 0 to 5), backoff 1 s doubling, capped at 10 s. Retried:
  timeouts, network errors, stream errors and HTTP 5xx. Not retried: 4xx, a bad payload, or a call
  the caller aborted (that error passes through as is).
- `think` per role: guardRisk is off by default (Granite spends about 65 s thinking otherwise).
  Temperature: write 0.2, every other role 0. The container passes the config seed (default 42),
  which goes with every generate call that has no seed of its own. `effectiveThink` and
  `effectiveTemperature` are the only place these rules live.
- Chat is streamed so headers arrive early (Node drops a response whose headers take over 300 s).
- A reply cut at the token limit is returned as is with a warning. `generateStructured` repairs it.
- `decide` limits: 1 to 64 questions, 2 to 26 choice options, 2 to 10 unique score levels.
  The state text is trimmed to 48,000 chars (10,000 for `strands-decider`, a 4K context model),
  less the size of the questions, never below 1,000. The cut keeps the head and 10% tail.
- Logs carry role, model, op, latency, attempts and token counts. Never a prompt or an answer.
- Untrusted text in the repair prompt is wrapped with `wrapUntrusted()` and `UNTRUSTED_DATA_RULE`.

## Files

| File                            | Role                                                                          |
| ------------------------------- | ----------------------------------------------------------------------------- |
| `ModelProvider.ts`              | The port and its request, answer and health types                             |
| `structured.ts`                 | `generateStructured`: schema in, validated object out, one repair             |
| `adapters/ollama.ts`            | `createOllamaProvider`, per-role defaults, `callOllama`, `health`             |
| `adapters/ollamaHttp.ts`        | fetch transport (JSON, NDJSON), typed errors, `isRetryable`, `toDigestError`  |
| `adapters/systemone.ts`         | Port questions and answers to and from `/v1/systemone`, limits, state trim    |
| `*.test.ts`                     | `structured.test.ts`, `adapters/ollama.test.ts`, `adapters/systemone.test.ts` |
| `adapters/__fixtures__/ollama/` | Responses recorded from Ollama 0.40.4 (chat stream, systemone, tags, version) |

## Depends on, used by

Depends on: `config/profiles` (adapter only), `domain/schemas` (`Role`, `StepName`), `shared`
(`errors`, `retry`, `telemetry`, `untrusted`).
Used by: `classify`, `select`, `write`, `guards`, `digest`, `app/container` and `app/tracedModel`,
`cli/doctor`, `cli/eval`, `evals/`, `test/fakes/FakeModelProvider.ts`.

## Change it safely

- Run `pnpm vitest run src/models`. The Ollama tests inject a fake `fetch` that serves the
  fixtures; no network. Real-model checks are in `test/live/` (`LIVE_OLLAMA=1`, one at a time).
- If Ollama changes a response, record it again into `__fixtures__/ollama/` and update the mapping
  and its test together.
- Do not import the adapters from `ModelProvider.ts` or `structured.ts`. ESLint blocks it.
- Do not log or trace prompts, system text or answers; they can hold collected text.
- Asking `judge` on a profile with no judge throws a `DigestError` by design (`modelsForRole`
  returns no tag). Do not paper over it with a default model.
- Keep timeouts, retries and `think` rules in the adapter, not in steps.
