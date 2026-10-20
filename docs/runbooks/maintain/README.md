# Maintain

Part of [Runbooks](../README.md).

Keep an installed digest healthy over months: the tool itself, models, disk, quality baselines,
test data and secrets.

| Runbook                                                              | Use it to                                                                        |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [Upgrade the tool](upgrade-the-tool.md)                              | Pull a new version, rebuild it (Node or Docker), check it, restart the scheduler |
| [Upgrade models](upgrade-models.md)                                  | Move to a newer model or Ollama build, check it, compare scorecards              |
| [Prune disk](prune-disk.md)                                          | Free space from old run folders, debug output and unused Ollama models           |
| [Re-baseline evals](re-baseline-evals.md)                            | Record a fresh scorecard and update the pages that quote it                      |
| [Add an eval case from a bad week](add-eval-case-from-a-bad-week.md) | Turn a wrong digest into labels or a case so a fix can be measured               |
| [Rotate secrets](rotate-secrets.md)                                  | Replace the SMTP password, Slack webhook or GitHub token without leaking either  |
