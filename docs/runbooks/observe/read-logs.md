# Read the logs

Part of [Runbooks](../README.md) / Observe.

## Purpose

Find the log lines of one week, one step or one model call, and read what they say. Logs are
the only place that keeps detail a run does not save in its run folder, such as a retry or a
dropped item.

## When to use

- You need more detail than [`digest show`](show-a-week.md) gives, for example why a model call
  was slow or which feed failed first.
- To watch a run while it works, use [Follow one run](follow-one-run.md).
- To see how long each model call took as a picture, use
  [View traces in Jaeger](view-traces-in-jaeger.md).

## Prerequisites

- Access to the standard output of the process: your terminal, or the Docker logs.
- `jq` is optional. Every filter below also works with `grep`.

## Steps

1. Find where the lines go. The app writes one JSON object per line to standard output (pino).
   Nothing is written to a log file.
   - Node: `pnpm digest run` prints the JSON lines and the human summary in the same stream.
   - Docker `serve` service: `docker compose logs digest`.
   - One-shot Docker command: `docker compose run --rm digest run` prints to your terminal.
2. Save a run so you can search it later.

   ```bash
   pnpm digest run --dry-run > run.log 2>&1
   ```

3. Read one line. Every line has `level`, `time` (ISO), `service` (`eng-digest`) and `msg`.
   Lines of a run also carry `runId` (the week), and lines inside a step carry `step`.

   ```json
   {
     "level": "info",
     "time": "2026-10-19T07:49:41.120Z",
     "service": "eng-digest",
     "runId": "2026-W43",
     "step": "classify",
     "ms": 38000,
     "msg": "Step finished"
   }
   ```

4. Filter by week or step with `grep`.

   ```bash
   grep '"runId":"2026-W43"' run.log | grep '"step":"write"'
   ```

5. Or filter with `jq`. The `-R` and `fromjson?` pair skips the non-JSON summary lines.

   ```bash
   jq -R -c 'fromjson? | select(.runId=="2026-W43" and .level != "info")' run.log
   ```

6. In Docker, filter the same way: `docker compose logs digest | grep '"runId":"2026-W43"'`.
7. Raise the detail with `LOG_LEVEL` in `.env`: `debug`, `info` (default), `warn` or `error`.
   The level is read when the app starts, so restart `serve` after a change.
8. Know the lines that matter.

   | `msg`                                    | Level       | Fields to read                             |
   | ---------------------------------------- | ----------- | ------------------------------------------ |
   | `Models ready`                           | info        | `profile`, `models`                        |
   | `Collected items`                        | info        | `items`, `failedSources`                   |
   | `Source failed`                          | warn        | `sourceId`, `error`                        |
   | `Source returned no usable items`        | warn        | `sourceId`, `fetched`                      |
   | `ollama call`                            | info        | `role`, `model`, `op`, `latencyMs`, tokens |
   | `ollama call failed, retrying`           | warn        | `op`, `attempt`, `error`                   |
   | `Draft failed the checks`                | warn        | `writer`, `attempt`, `rejectedBy`          |
   | `Step finished` / `Step failed`          | info, error | `step`, `ms` (and `error` on failure)      |
   | `Winner chosen`                          | info        | `writer`, `judged`                         |
   | `Run finished`                           | info        | `status`, `winner`, `counts`               |
   | `input guards dropped item` (debug only) | debug       | `itemId`, `flaggedBy`                      |

   A model-call line (`ollama call`) holds the role, the model tag, the operation (`generate`
   or `decide`), `latencyMs`, `attempts`, `inputTokens` and `outputTokens`. It never holds a
   prompt or an answer.

## Verify

`grep -c '"msg":"Run finished"' run.log` prints `1` for a finished run. The `Run finished` line
shows the same `status` and `counts` as `pnpm digest show <week>`.

## Roll back

Nothing changed. To return to the default detail, remove `LOG_LEVEL` from `.env` and restart.

## Troubleshooting

| Symptom                        | Cause                                       | Fix                                    |
| ------------------------------ | ------------------------------------------- | -------------------------------------- |
| `jq: parse error`              | The stream mixes the summary with JSON      | Use `jq -R 'fromjson?'` as in step 5   |
| No `runId` on a line           | The line is outside a run, such as start-up | Filter by time instead                 |
| `debug` lines do not show      | `LOG_LEVEL` is still `info`                 | Set `debug` in `.env`, restart `serve` |
| `LOG_LEVEL` is ignored         | The process environment wins over `.env`    | Unset the variable in the shell        |
| Secrets look like `[redacted]` | The logger replaces every known secret      | Expected; the real value is in `.env`  |
| Docker logs are empty          | The `digest` service is not running         | `docker compose ps`, then `up -d`      |

## Related

- [Follow one run](follow-one-run.md) and [Show a week](show-a-week.md)
- [Observability](../../features/observability.md) and
  [environment variables](../../reference/environment-variables.md)
- [src/observability/CLAUDE.md](../../../src/observability/CLAUDE.md)
