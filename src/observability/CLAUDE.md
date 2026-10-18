# Observability

## Intent

Logs and traces for a run, with secrets taken out before anything is written. The pipeline sees
only the `Logger` and `Tracer` interfaces from `shared/telemetry`. This folder is the real
implementation: pino for JSON logs, OpenTelemetry for optional traces, and one redactor that both
use. An SMTP password, a Slack webhook or a GitHub token must never reach a log line or a span.

## How it works

1. `app/container` collects the secret values (`knownSecrets`) and calls
   `createLogger({ level, redactValues })`.
2. `createLogger` builds a pino logger (JSON on stdout, ISO time, a `level` label, and
   `service: "eng-digest"`) and wraps it. Every message and field bag goes through the redactor.
   `child(fields)` redacts its bindings too. A line below the level is dropped before any redaction.
3. `createRedactor(secrets)` returns `{ text, value, fields }`. It replaces each secret, its
   percent-encoded form and its JSON-escaped form with `[redacted]`. It walks strings, nested
   objects, arrays, keys and `Error` parts (message, stack, cause, `AggregateError` members).
4. `createTracer({ endpoint, redactValues, ... })` returns a no-op tracer when `endpoint` is empty.
   Otherwise it registers a `NodeTracerProvider` with a batch OTLP/HTTP exporter.
   `span(name, attributes, fn)` runs `fn` in an active span. The name, attribute keys and values,
   the exception and the status message are redacted. The original error is rethrown unchanged.
5. When a run ends, `container.close()` calls `shutdown()`. It flushes the spans and releases the
   global OpenTelemetry registration. A failed flush is logged as a warning and never fails the run.

## Design

- Redaction goes by value, not by key name. A secret is matched as plain text (escaped for the
  regex), longest first, so a short secret never splits a long one. Empty secrets are ignored.
- The redactor never throws and never changes its input. A field it cannot read becomes
  `{ fields: '[unserializable]' }`. Depth over 10 gives `[truncated]`, a cycle gives `[circular]`,
  binary data gives `[binary N bytes]`. A logging call cannot break the pipeline.
- The pino `err` serializer is replaced by identity, because the redactor has already flattened
  and cleaned each error.
- Only one tracer can be live. OpenTelemetry keeps a process-wide provider and context manager,
  so `createTracer` with an endpoint throws until the earlier tracer has finished `shutdown()`.
- `shutdown()` waits at most `shutdownTimeoutMs` (default 5000), which is also the exporter
  request timeout. It then rejects. Repeated calls share one result.
- Span attributes keep strings, numbers, booleans and arrays of one primitive kind. Anything
  else is JSON text. `null` and `undefined` are dropped.
- `pino-pretty` is a dev dependency. `createLogger` loads it only for `pretty: true`. Nothing in
  `src` sets that option today.
- Neither the logger nor the tracer knows what is sensitive beyond the secret list. Prompts and
  model answers must not be passed in at all (see `src/models/CLAUDE.md`).

## Files

| File         | Role                                                                           |
| ------------ | ------------------------------------------------------------------------------ |
| `logger.ts`  | `createLogger`, `LoggerOptions`: pino wrapped with the redactor                |
| `redact.ts`  | `createRedactor`, `Redactor`, markers `REDACTED`, `CIRCULAR`, `TRUNCATED`      |
| `tracing.ts` | `createTracer`, `TracingHandle`, `TracerOptions`: OpenTelemetry or no-op       |
| `*.test.ts`  | `logger.test.ts`, `redact.test.ts`, `tracing.test.ts`                          |
| fixtures     | None. Tests inject a stream as `destination` and an in-memory span `exporter`. |

## Depends on, used by

Depends on: `shared/telemetry`, `shared/errors` (`errorMessage`), `pino`, `@opentelemetry/*`.
Used by: `app/container` (logger, tracer, redactor), `app/redacting` (the `Redactor` type),
`config/load` (`redactSecrets`), `cli/show` and `cli/preview` (redactor), `cli/eval` (logger),
`evals/recordWeeks` (redactor). Pipeline features must not import it; ESLint blocks that.

## Change it safely

- Run `pnpm vitest run src/observability src/app`. The `src/app` tests (`container.secrets.test.ts`,
  `redacting.test.ts`) check that a secret reaches no log, span or stored record.
- In tracing tests, always `await handle.shutdown()`. A second live tracer throws
  "A tracer is already active".
- Keep the redactor fail-safe. A new kind of value must end as a safe marker, not as an exception
  and not as raw text.
- Do not log an object you did not pass through `fields()` or `child()`. Do not log prompts,
  model answers or collected text.
- A new OpenTelemetry package is a new dependency. Ask the coordinator.
