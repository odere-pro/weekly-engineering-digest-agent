# App

## Intent

The pipeline knows only ports. Something has to pick the real adapters, hand them their config and
secrets, and make sure no secret leaks on the way. That is this feature: the composition root. The
CLI, the scheduler and the evals call it once and get a ready `DigestDeps`.

## How it works

1. `buildApp(loaded)` takes the `LoadedConfig` and resolves to `{ deps, close }`. Every failure
   is a rejection, so callers handle one failure path.
2. `buildDeliveries` makes the channels: the Markdown file always, SMTP when `delivery.email` is
   set, Slack when `delivery.slack.enabled`. A missing `SMTP_PASSWORD` or `SLACK_WEBHOOK_URL` is a
   `DigestError` that names the variable. This runs first, before anything starts.
3. `knownSecrets(secrets)` feeds one `Redactor` and the logger.
4. The model is `traceModel(createModelProvider(...))`. RSS and GitHub fetchers, two input guards
   and two output guards are built on it.
5. Each channel becomes `redactDelivery(withDeliveryRetry(channel))`. The store becomes
   `redactStore(createFsRunStore(...))`.
6. The real tracer is built last and bound into the deferred tracer. `deps.tracer` is wrapped by
   `scopeRuns`. `close()` shuts the tracer down and only logs a failure.
7. `createModelProvider` (also used by `digest doctor`) and `samplingOf` (seed and temperature
   per role, for the run record) are exported helpers.

## Design

- This is the only place that turns config into adapters. Core never imports `app`.
- Secrets are guarded in layers. Adapters keep them out of errors. The logger and tracer redact
  what they write. `redactStore` and `redactDelivery` redact everything that reaches disk or a
  channel, so one leaky adapter ends up in none of them.
- `redactStore` removes secrets from artifacts and the run record, then checks the record against
  `RunRecordSchema`. A record that no longer fits is not saved (safer than saved wrong).
- `knownSecrets` adds the Slack webhook path, because the path is the secret part of that URL.
- Redaction wraps the retry, so every retry sends the same redacted message.
- Retry (`withDeliveryRetry`): 2 retries, 5 s then 10 s (base 5 s, cap 30 s). It retries only when
  sending again cannot double the message: connect-phase codes (`ECONNREFUSED`, `ENOTFOUND`,
  `EAI_AGAIN`, `EHOSTUNREACH`, `ENETUNREACH`, `EDNS`, `UND_ERR_CONNECT_TIMEOUT`), SMTP connect,
  greeting and upgrade timeouts, HTTP 429 and 5xx, SMTP 421, 450 and 451. A reset or socket timeout
  after the body went out is not retried. The decision reads `DeliveryError` facts, never text.
- Model, fetchers and guards are built once, but `digest serve` runs many weeks. `perRunLogger`
  looks up the logger of the run in flight (AsyncLocalStorage), so lines carry the right `runId`
  and `step`. `scopeRuns` sets that scope from the span attributes core passes.
- `traceModel` puts the role and model on `model.generate` or `model.decide` spans and the token
  counts on an inner `model.usage` span. Never a prompt, a text or an answer.
- The tracer is built last, so a failure earlier never leaves a tracer registered process-wide.

## Files

| File                                                 | Role                                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------------------------ |
| `container.ts`                                       | `buildApp`, `createModelProvider`, `samplingOf`, per-run logger and span scope |
| `redacting.ts`                                       | `knownSecrets`, `redactStore`, `redactDelivery`                                |
| `retryingDelivery.ts`                                | `withDeliveryRetry`, `isTransientDeliveryError`                                |
| `tracedModel.ts`                                     | `traceModel`, `deferTracer`                                                    |
| `container*.test.ts`                                 | Wiring, secrets, model, run logging (two files), local output, Docker paths    |
| `redacting`, `retryingDelivery`, `tracedModel` tests | One test file each                                                             |
| `scheduler*.test.ts`                                 | Tests for `src/scheduler/scheduler`, kept here (see below)                     |

There is no `__fixtures__/`. `container.docker.test.ts` reads `Dockerfile` and `docker-compose.yml`.

## Depends on, used by

Depends on: the adapters of `delivery`, `guards`, `models`, `sources` and `store`; `config` (types
and profiles); `digest` (`DigestDeps` type); `domain`; `observability` (logger, redact, tracing);
`shared`.
Used by: `cli` (`run`, `serve`, `doctor`, `eval`, `preview`, `show`), `evals/`,
`test/integration/harness.ts`, `test/live/smoke.live.test.ts`.

## Change it safely

- Run `pnpm vitest run src/app`. The container tests wrap each factory with a spy that still
  builds the real adapter, then check the options it got. No network.
- A new channel in `buildDeliveries` gets retry and redaction for free through `guardChannels`.
- `redactStore`, `redactDelivery`, `redactedView`, `traceModel` and `withDeliveryRetry` list their
  methods and fields by hand. A new port method, `DigestView` field or `DigestMessage` field must
  be added there, or it is dropped or skipped silently.
- Never log or trace secret values or prompts. `container.secrets.test.ts` guards this.
- `scheduler*.test.ts` sit here because an earlier issue owned this folder. They test
  `src/scheduler/scheduler.ts`: `schedulerRetry` with fakes, `schedulerRunDigest` with the real
  `runDigest` and run store.
- Keep `createModelProvider` free of per-run state; doctor calls it with only `health()` in mind.
