# Observability

Part of [Features](README.md).

## What it is for

Logs and traces for a run, with secrets taken out before anything is written. The pipeline sees
only a logger and a tracer interface. This feature is the real implementation: pino for JSON logs,
OpenTelemetry for optional traces, and one redactor that both use. An SMTP password, a Slack
webhook or a GitHub token must never reach a log line or a trace.

## Where it sits

It is a supporting layer built by the app wiring. Pipeline features never import it. See
[feature folders](../architecture/feature-folders.md).

## What it does

- Writes logs as JSON, one line each, on stdout and, for runs and `digest eval`, also to the day's
  file `<dataDir>/logs/<day>/digest.log`. The day is the date in `schedule.timeZone`, so a `serve`
  process starts a new file at midnight. Each line has an ISO time, a `level` label and the field
  `service` set to `eng-digest`. Lines of a run carry its `runId` (the week) and, inside a step,
  the `step`. Each model call logs role, model, latency, attempts and token counts. No prompt, no
  answer and no feed text.
- Sets the level from `LOG_LEVEL` (`debug`, `info`, `warn`, `error`; default `info`).
- Redacts by value, not by key name. Each secret, its percent-encoded form and its JSON-escaped
  form become `[redacted]`, in messages, fields, keys and errors (message, stack and cause).
- Never throws on bad input. A field it cannot read becomes `[unserializable]`, a cycle
  `[circular]`, a very deep object `[truncated]` and binary data `[binary N bytes]`. A logging call
  cannot break the pipeline.
- Exports traces only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Otherwise the tracer does
  nothing. With an endpoint it sends one span per run, per step and per model call over OTLP/HTTP.
  Span names, attributes and errors are redacted too. No prompt, state or answer goes into a span.
- At the end of a run, shutdown flushes the spans, waiting at most 5 seconds. A failed flush is a
  warning and never fails the run.
- Only one tracer can be live in a process.

## What you can configure

- `LOG_LEVEL` and `OTEL_EXPORTER_OTLP_ENDPOINT` in `.env` or the environment. See
  [environment](../configuration/environment.md) and
  [environment variables](../reference/environment-variables.md).
- The log file follows `dataDir` and `schedule.timeZone`. The log folders of days before the oldest kept week (`keepWeeks`) are deleted after a run.
- Nothing else. The redaction list is the three declared secrets plus the Slack webhook path.
- With Docker Compose the `tracing` profile adds Jaeger on port 16686. See
  [view traces in Jaeger](../runbooks/observe/view-traces-in-jaeger.md).

## What can go wrong

- Too much or too little detail in the logs: change `LOG_LEVEL`. See
  [read logs](../runbooks/observe/read-logs.md) and
  [follow one run](../runbooks/observe/follow-one-run.md).
- The log file cannot be written (a read-only folder, a full disk, an unknown time zone): one
  warning goes to stderr and the logs continue on stdout only. A folder removed under a running
  process is made again. The run is not affected.
- No traces appear: the endpoint is empty or wrong, or the collector is down. The run still
  succeeds; the flush failure is only a warning. See
  [observability operations](../operations/observability.md).
- A password you put inside `OLLAMA_URL` or the trace endpoint is not on the redaction list. Keep
  secrets in the three declared variables.
- A suspected leak of a secret into a log or trace is a bug. Rotate the secret. See
  [rotate secrets](../runbooks/maintain/rotate-secrets.md) and [safety](../architecture/safety.md).

## Code and tests

- Folder: [src/observability/](../../src/observability/). Maintainer notes:
  [CLAUDE.md](../../src/observability/CLAUDE.md).
- No port. The interfaces live in [shared](shared.md); this folder holds the pino, OpenTelemetry
  and redaction code.
- Tests sit next to the code. They write to an in-memory stream and exporter. The app tests also
  check that a secret reaches no log, span or stored record.

## Related

- [app](app.md) builds the logger and tracer and gives each run its own scope.
- [models](models.md) logs each call without the prompt. [shared](shared.md) holds the interfaces.
- [cli](cli.md) uses the redactor when it prints saved data.
