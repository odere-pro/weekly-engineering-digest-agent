# Observe runbooks

Part of [Runbooks](../README.md).

Look at what the digest agent is doing or did, without changing anything. All five runbooks
are read-only. Start with run history, then open the week that looks wrong.

| Runbook                                           | Use it to                                                |
| ------------------------------------------------- | -------------------------------------------------------- |
| [View run history](view-run-history.md)           | List past runs with status, counts, duration and winner  |
| [Show a week](show-a-week.md)                     | Read the saved summary, items, scores, drafts and digest |
| [Read the logs](read-logs.md)                     | Find the JSON log lines of one week, step or model call  |
| [Follow one run](follow-one-run.md)               | Watch a run while it works and tell slow from stuck      |
| [View traces in Jaeger](view-traces-in-jaeger.md) | See a run as a timeline of steps and model calls         |

When a status is not `sent`, go on to the [debug runbooks](../debug/README.md).
