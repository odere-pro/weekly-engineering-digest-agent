# Observability

> The real `Logger` and `Tracer`: pino JSON logs (on stdout and in a file per day), optional
> OpenTelemetry traces, and the redactor both write through. The pipeline sees only the `shared/telemetry` interfaces; `app/container` wires this.
> Entry: `createLogger(options)` (`options.file` adds the day file), `createTracer(options) → TracingHandle`,
> `createRedactor(secrets)`.

## Context

```mermaid
flowchart LR
  container["app/container"] -->|"createLogger, createTracer, createRedactor"| obs["observability"]:::focus
  others["config/load, cli/show, cli/preview, cli/eval, evals/recordWeeks"] -->|"createRedactor, createLogger"| obs
  obs -.->|"implements"| telemetry[["Logger, Tracer (shared/telemetry)"]]
  container -->|"Logger, Tracer in DigestDeps"| pipeline["pipeline steps"]
  pipeline -.->|"info, warn, child, span"| telemetry
  obs -->|"JSON lines"| stdout[("stdout")]
  obs -->|"the same lines"| logfile[("dataDir/logs/day/digest.log")]
  obs -.->|"logsDir, dayOf"| layout["store/layout"]
  obs -->|"OTLP/HTTP spans"| otlp[("Jaeger or any OTLP collector")]
  classDef focus stroke-width:3px
```

## Flow

```mermaid
flowchart TD
  redactor["createRedactor(redactValues): one each in logger and tracer"] --> logCall["Logger call: message, fields"]
  logCall --> level{"level enabled?"}
  level -->|"no"| dropped["dropped, fields never read"]
  level -->|"yes"| pino["redact message and fields, pino JSON line on stdout and in the day's file"]
  redactor --> spanCall["Tracer.span(name, attributes, fn)"]
  spanCall --> endpoint{"OTLP endpoint set?"}
  endpoint -->|"no"| noop["no-op: runs fn"]
  endpoint -->|"yes"| span["redact name and attributes, run fn in an active span"]
  span -->|"fn throws"| fail["record redacted exception, rethrow unchanged"]
  span --> batch["BatchSpanProcessor to OTLP/HTTP"] --> shutdown["close(): shutdown flushes within 5 s"]
```

- The day file is `<dataDir>/logs/<day>/digest.log`, `<day>` the line's date in `schedule.timeZone`
  (`dayOf`): a `serve` process starts a new file at midnight. `app/container.createAppLogger` sets it
  for runs and `digest eval`; other `createLogger` callers log to stdout only.
- Tracing is on only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set (Compose `tracing` profile: Jaeger UI
  `127.0.0.1:16686`, endpoint `http://jaeger:4318/v1/traces`). `LOG_LEVEL` sets the level, default `info`.
- Spans of a real run: `runDigest` (`runId`, `dryRun`), one per step (`runId`, `step`), `deliver` on a
  resumed run, `model.generate` / `model.decide` with an inner `model.usage` (`app/tracedModel.ts`).

## Rules

- Redact by value, not by key name: each secret, its percent-encoded and JSON-escaped form become
  `[redacted]`. Longest first, so a short secret never splits a long one; literal match; empty ignored.
- The redactor never throws and never mutates its input, so a log call cannot break the pipeline: an
  unreadable bag becomes `{ fields: '[unserializable]' }`, depth over 10 `[truncated]`, a cycle
  `[circular]`, binary `[binary N bytes]`. It walks keys, `toJSON` and `Error` parts (message, stack,
  cause, `AggregateError`), so pino's `err` serializer is identity.
- Everything written is redacted first: message, field names and values, `child` bindings, span name,
  attribute keys and values, exception, status message. A line below the level is dropped before that.
- A telemetry failure never replaces the caller's error: `recordFailure` is best effort, the original
  error is rethrown.
- One live tracer: OpenTelemetry keeps a process-wide provider, so `createTracer` with an endpoint
  throws until the earlier `shutdown()` finished. No endpoint gives a no-op, not counted.
- `shutdown()` waits at most `shutdownTimeoutMs` (5000, also the exporter's request timeout), then
  rejects; the global registration is released either way. `container.close()` logs a warning, never fails.
- The day file is `dailyLogFile.ts`: lines are appended one by one, synchronously, so they keep
  their order and survive an exit. If the logs folder was removed under a running process it is
  made again and the line retried once. A write that still fails, or an unknown time zone, never
  throws: it is reported once on stderr and the line still reached stdout. `store` prune removes the
  folders of days older than the oldest kept week (`keepWeeks`).
- Span attributes keep strings, numbers, booleans and arrays of one primitive kind; else JSON text.

## Files

| File              | Role                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| `logger.ts`       | `createLogger`, `LoggerOptions`: pino (`service: "eng-digest"`, ISO time) plus the redactor    |
| `dailyLogFile.ts` | `createDailyLogFile`, `DailyLogFileOptions`: the pino destination that appends to the day file |
| `redact.ts`       | `createRedactor`, `Redactor`; markers `REDACTED`, `CIRCULAR`, `TRUNCATED`, `UNSERIALIZABLE`    |
| `tracing.ts`      | `createTracer`, `TracingHandle`, `TracerOptions`: `NodeTracerProvider` with OTLP, or no-op     |

Tests sit next to each file; they inject a stream as `destination` and an in-memory span `exporter`.

## Gotchas

- `Redactor` is also used by `app/redacting.ts` (run store, deliveries), `config/load` (`redactSecrets`),
  `cli/show`, `cli/preview`, `evals/recordWeeks`: a change reaches stored records and messages.
- The span attributes `runId` and `step` also pick the per-run logger (`scopeRuns` in `app/container.ts`).
- `logger.test.ts` pins the line shape (ISO `time`, `level` label, `service`, no `pid`) and that `%s` in
  a message stays verbatim: call pino with the message as its only string.
- Tracing tests must `await handle.shutdown()`; a second live tracer throws "A tracer is already active".
- `pretty: true` needs `pino-pretty`, a dev dependency; nothing in `src` sets it.
- Never pass prompts, answers or collected text as fields or attributes (`src/models/CLAUDE.md`).
