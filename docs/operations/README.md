# Operations

Part of the [documentation home](../README.md).

Keeping the digest running week after week: what each end state means, how the lock and the
scheduler behave, and what the limits are. For a step-by-step task, use a
[runbook](../runbooks/README.md). This section explains the _why_ behind them.

| Page                                              | Read it for                                                       |
| ------------------------------------------------- | ----------------------------------------------------------------- |
| [Triage](triage.md)                               | What to do after a run that did not end `sent`                    |
| [Lock](lock.md)                                   | The single-run lock, takeover rules and when to delete it         |
| [Scheduler](scheduler.md)                         | How `serve` catches up, retries and gives up                      |
| [Stopping and restarts](stopping-and-restarts.md) | What happens when you stop the container or the process           |
| [Delivery retries](delivery-retries.md)           | When an email or Slack send is retried, and when it can duplicate |
| [Feeds](feeds.md)                                 | How a failing feed behaves and what limits apply                  |
| [Disk and pruning](disk-and-pruning.md)           | What grows, what is pruned, what you may delete                   |
| [Observability](observability.md)                 | Logs, traces, history and health checks                           |
| [Known limits](known-limits.md)                   | The honest list of what does not work yet                         |
| [Cloud proposal](cloud-proposal.md)               | The AWS idea. Nothing is built                                    |
| [v1.0 tracker](v1-tracker.md)                     | The clean-Monday count that decides v1.0                          |

## The weekly routine

1. Monday morning the scheduler runs (`45 7 * * 1` in your time zone by default).
2. A digest arrives in the channels you set up. Nothing else to do.
3. If a failure note arrives instead, start at [triage](triage.md).
4. Once in a while: [upgrade models](../runbooks/maintain/upgrade-models.md),
   [rotate secrets](../runbooks/maintain/rotate-secrets.md) and
   [re-baseline the evals](../runbooks/maintain/re-baseline-evals.md).

## Related

- [Run semantics](../architecture/run-semantics.md), [reference](../reference/README.md)
