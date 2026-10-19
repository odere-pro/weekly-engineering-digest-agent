# Metrics

Part of [Evaluation](../README.md).

`digest eval` makes 17 measurements. Each has a page with the same headings: what it measures, why
it matters, how it is computed, the gate, the data it uses, how to add a case and the current
result. The current numbers are on [results](../results.md); the rules for gates are on
[gates](../gates.md).

| Metric                     | Gate                            | Set                                                                                 | Page                                          |
| -------------------------- | ------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------- |
| Link validity              | hard, at least 100%             | [recorded weeks](../sets/recorded-weeks.md), [attacks](../sets/attacks.md)          | [link-validity](link-validity.md)             |
| Attack handling            | hard, at least 100%             | [attacks](../sets/attacks.md)                                                       | [attack-handling](attack-handling.md)         |
| Guard attack recall        | soft, at least 90%              | [attacks](../sets/attacks.md)                                                       | [guard-attack-recall](guard-attack-recall.md) |
| Groundedness               | hard, at least 100%             | [grounding](../sets/grounding.md)                                                   | [groundedness](groundedness.md)               |
| Format                     | hard, at least 100%             | [recorded weeks](../sets/recorded-weeks.md)                                         | [format](format.md)                           |
| Guard false blocks         | soft, at most 5%                | [recorded weeks](../sets/recorded-weeks.md), [grounding](../sets/grounding.md)      | [guard-false-blocks](guard-false-blocks.md)   |
| Guard blocks on real weeks | soft, at most 5%                | [recorded weeks](../sets/recorded-weeks.md), [stability runs](../sets/stability.md) | [guard-real-blocks](guard-real-blocks.md)     |
| Must-include recall        | soft, at least 3 of 5           | [recorded weeks](../sets/recorded-weeks.md)                                         | [must-include-recall](must-include-recall.md) |
| Must-exclude leaks         | soft, at most 0.5 a week        | [recorded weeks](../sets/recorded-weeks.md)                                         | [must-exclude-leaks](must-exclude-leaks.md)   |
| Classifier accuracy        | soft, at least 80%              | [classifier cases](../sets/classifier-cases.md)                                     | [classifier-accuracy](classifier-accuracy.md) |
| Writing quality            | soft, at least 3.5, needs judge | [judge](../sets/judge.md), [recorded weeks](../sets/recorded-weeks.md)              | [writing-quality](writing-quality.md)         |
| Selection agreement        | soft, at least 70%, needs judge | [judge](../sets/judge.md)                                                           | [selection-agreement](selection-agreement.md) |
| Writer win rate            | none                            | [recorded weeks](../sets/recorded-weeks.md)                                         | [writer-win-rate](writer-win-rate.md)         |
| Stability                  | soft, at least 4 shared items   | [stability runs](../sets/stability.md)                                              | [stability](stability.md)                     |
| Run time                   | none                            | [recorded weeks](../sets/recorded-weeks.md)                                         | [run-time](run-time.md)                       |
| Source parse yield         | soft, at least 95%              | [source recordings](../sets/source-recordings.md)                                   | [source-parse](source-parse.md)               |
| Source summary fill        | soft, at least 90%              | [source recordings](../sets/source-recordings.md)                                   | [source-summary-fill](source-summary-fill.md) |

"Hard" gates fail the run when missed. "Soft" gates show a pass or fail. "None" is reported only.
"Needs judge" means the gate applies only when the judge is calibrated.

To measure only some of them, see [running parts of the eval](../running-sections.md).

To list the current value of every metric, run
`grep -rn "Current result" docs/evaluation/metrics`.
