# Debug runbooks

Part of [Runbooks](../README.md).

Find the cause of a run that did not end `sent`. Start with `pnpm digest history -n 4`, then
`pnpm digest show <week>`, then `pnpm digest doctor`, and open the page that matches the
status or the symptom.

| Runbook                                                       | Use it to                                                      |
| ------------------------------------------------------------- | -------------------------------------------------------------- |
| [Failed run](failed-run.md)                                   | Find the step and cause of a `failed` run (exit code 1)        |
| [Blocked run](blocked-run.md)                                 | See why every draft was rejected: fallback digest, or exit 2   |
| [Quiet week](quiet-week.md)                                   | Find where the items went in a `quiet` week (exit code 3)      |
| [Failing feed](failing-feed.md)                               | Fix a source that fails or returns nothing                     |
| [Slow model or out-of-memory](slow-model-or-out-of-memory.md) | Fix model timeouts, long runs and Ollama running out of memory |
| [Stuck lock](stuck-lock.md)                                   | Free the run lock safely when `Another run is in progress`     |
| [Failed delivery](failed-delivery.md)                         | Fix an email or Slack channel that did not get the digest      |
| [Missing or wrong item](missing-or-wrong-item.md)             | Find where an item was lost, or why a wrong one got in         |

To fix a week once you know the cause, see the [recover runbooks](../recover/README.md).
