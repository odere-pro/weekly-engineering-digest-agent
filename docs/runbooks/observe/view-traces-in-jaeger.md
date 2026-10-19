# View traces in Jaeger

Part of [Runbooks](../README.md) / Observe.

## Purpose

See one run as a timeline: how long each step and each model call took, and where a failure
happened. Traces are optional and off by default.

## When to use

- A run is slow and you want to see which step or model call used the time.
- You want the shape of a run, not its text. For text, use [Read the logs](read-logs.md).
- For a saved summary of timings with no extra tools, use [Show a week](show-a-week.md): its
  `Timings` line lists the time of each step.

## Prerequisites

- Docker Compose 2.24 or newer for the Jaeger container.
- Access to edit `.env`. Traces carry no prompt text, so no private content leaves the machine.

## Steps

1. Set the endpoint in `.env`. In Docker the app reaches Jaeger by its service name.

   ```text
   OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318/v1/traces
   ```

2. Start Jaeger. It lives in the `tracing` profile of `docker-compose.yml`.

   ```bash
   docker compose --profile tracing up -d
   ```

   On a Mac, `make tracing-up` runs the same command and sets the variable for that call.
   Put it in `.env` as well, or later one-shot commands will not trace.

3. Restart `serve` so it reads the variable. The app builds its tracer once at start.

   ```bash
   docker compose restart digest
   ```

4. Node instead of Docker: the endpoint must be `http://localhost:4318/v1/traces`, and
   something must listen on that port. The Compose `jaeger` service publishes only the UI port
   16686 on `127.0.0.1`, not 4318. Either add `'127.0.0.1:4318:4318'` to its `ports` or start
   Jaeger yourself with both ports published, then set the variable in `.env`.
5. Run a week, for example a dry run, so a trace exists.

   ```bash
   pnpm digest run --dry-run
   ```

6. Open `http://localhost:16686`. Pick the service `eng-digest` and press Find Traces. To find
   one week, search the tag `runId=2026-W43`.
7. Read the spans. The tree is:

   | Span                                        | Attributes                                                  |
   | ------------------------------------------- | ----------------------------------------------------------- |
   | `runDigest` (the whole run)                 | `runId`, `dryRun`                                           |
   | `collect`, `guardInput`, ... (one per step) | `runId`, `step`                                             |
   | `model.generate`, `model.decide`            | `role`, and `model` when the writer is named                |
   | `model.usage` (inside a call)               | `role`, `model`, `latencyMs`, `inputTokens`, `outputTokens` |

   A failed step shows an error status and the exception. Spans never hold a prompt, an item
   text or a model answer. Known secrets are replaced with `[redacted]`.

## Verify

After a run, `eng-digest` appears in the Service list and a `runDigest` trace with the week in
`runId` has one span for each step that ran (a dry run has no `deliver`).

## Roll back

Remove the variable from `.env` and restart `serve`. Stop Jaeger when you are done.

```bash
docker compose --profile tracing rm -sf jaeger
```

## Troubleshooting

| Symptom                              | Cause                                              | Fix                                          |
| ------------------------------------ | -------------------------------------------------- | -------------------------------------------- |
| `Invalid environment` on start       | The endpoint is not a full URL                     | Use `http://host:4318/v1/traces`             |
| No service `eng-digest`              | Variable unset in the running process              | Set it in `.env`; restart `serve`            |
| Node run cannot reach Jaeger         | Port 4318 is not published                         | Step 4                                       |
| `tracer shutdown failed` in the logs | The collector was down at the end of the run       | Start Jaeger; the run itself is not affected |
| A killed run has a partial trace     | Spans wait in a batch; a killed process loses them | Use the logs for a run that was killed       |

## Related

- [Read the logs](read-logs.md) and [Environment variables](../../reference/environment-variables.md)
- [Observability](../../operations/observability.md)
- [src/observability/CLAUDE.md](../../../src/observability/CLAUDE.md)
