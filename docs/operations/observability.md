# Observability

Part of [Operations](README.md).

Four ways to see what the agent did: logs, traces, history and health checks.

## Logs

- pino JSON on stdout. The level comes from `LOG_LEVEL` (`debug`, `info`, `warn`, `error`;
  default `info`).
- `run`, `serve` and `eval` also write every line to `dist/logs/<day>/digest.log` (`<dataDir>`
  instead of `dist` if you changed it). `<day>` is the date in `schedule.timeZone`, so there is
  one file per day. Logs of days older than the oldest kept week (`keepWeeks`) are deleted by pruning.
- Lines of a run carry `runId` (the week id). Lines inside a step also carry `step`.
- Each model call logs the role, the model, the latency, the attempts and the token counts, and
  `coldStart: true` when the model was not loaded yet. Never a prompt or an answer.
- The input guard, the output guard and `classify` also log a `Progress` line every 25 items or
  minute: `label` (the guard or `classify`), `done`, `total`, `elapsedMs`, `medianMs` and the time
  left (`etaMs`, `eta`). The estimate is the median time per item so far times the items left.
- Secrets are redacted by value before a line is written.

In Docker: `docker compose logs digest`. See [read logs](../runbooks/observe/read-logs.md) and
[follow one run](../runbooks/observe/follow-one-run.md).

## Traces

Set `OTEL_EXPORTER_OTLP_ENDPOINT` to export OpenTelemetry spans: one per run, per step and per
model call. No prompt, state or answer goes into a span. The Compose `tracing` profile adds
Jaeger on `http://localhost:16686`. See
[view traces in Jaeger](../runbooks/observe/view-traces-in-jaeger.md).

## History

Every run writes `dist/<monday>/digest/run.json` (`dist/2026-10-19/digest/run.json` for `2026-W43`). `pnpm digest history` lists past runs (status,
item counts, duration, winner). `pnpm digest show <week>` prints one run. See
[view run history](../runbooks/observe/view-run-history.md) and
[show a week](../runbooks/observe/show-a-week.md).

## Health

`pnpm digest doctor` checks config, Ollama, models, feeds, delivery, `.env`, guards and the data
folder, and prints a `fix:` line for each problem. `doctor --readiness` prints a verdict per
profile for this machine.

## Quality

`pnpm digest eval` replays recorded weeks and writes a scorecard. See
[evaluation](../evaluation/README.md).

## Related

- [Observability feature](../features/observability.md), [triage](triage.md)
