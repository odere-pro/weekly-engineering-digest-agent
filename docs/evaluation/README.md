# Evaluation

Part of the [documentation home](../README.md).

The evaluation answers one question: is the digest good, and is it still as good as last time?
`digest eval` replays frozen test data through the real pipeline and models, with no network for
feeds and nothing delivered. It scores the result with 18 measurements and saves a scorecard. If a
hard gate fails, the command exits with 1.

Start here:

| Page                                             | What you get                                                                       |
| ------------------------------------------------ | ---------------------------------------------------------------------------------- |
| [How evals work](how-evals-work.md)              | What `digest eval` does from start to end, and what it costs in time               |
| [Gates](gates.md)                                | Hard, soft and no gate, the 18 thresholds, the judge rule, the exit code           |
| [Running parts of the eval](running-sections.md) | `--only` a section, `--resume` a lost run, `--compare` two scorecards, checkpoints |
| [Current results](results.md)                    | The newest scorecard, row by row, and how to update the page                       |
| [Adding cases](adding-cases.md)                  | How to add data to each set and which rules the tests enforce                      |

The feature in the code is described in [evals](../features/evals.md). To run it, follow
[run the evals](../runbooks/run/run-evals.md); to refresh the baseline, follow
[re-baseline the evals](../runbooks/maintain/re-baseline-evals.md).

## Eval sets

The data lives in `evals/`. The [sets index](sets/README.md) explains how the sets relate.

| Set                                            | What                                                          |
| ---------------------------------------------- | ------------------------------------------------------------- |
| [Recorded weeks](sets/recorded-weeks.md)       | 6 real weeks of feed items with the maintainer's picks        |
| [Stability runs](sets/stability.md)            | The same weeks replayed three times                           |
| [Classifier cases](sets/classifier-cases.md)   | 60 labeled items, and the threshold tuning                    |
| [Attack cases](sets/attacks.md)                | 31 fake items with injected instructions, 10 of them held out |
| [Grounding cases](sets/grounding.md)           | 30 drafts with one planted false claim each, 10 held out      |
| [Source recordings](sets/source-recordings.md) | 24 recorded feed responses with the items they must yield     |
| [Judge and calibration](sets/judge.md)         | The rubric, the eval judge and the 10-digest grading sheet    |

## Metrics

The [metrics index](metrics/README.md) has a table with the gate and the data of each one.

| Group     | Metrics                                                                                                                                                                                                                                                                                                   |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Safety    | [link validity](metrics/link-validity.md), [attack handling](metrics/attack-handling.md), [guard attack recall](metrics/guard-attack-recall.md), [groundedness](metrics/groundedness.md), [guard false blocks](metrics/guard-false-blocks.md), [guard blocks on real weeks](metrics/guard-real-blocks.md) |
| Shape     | [format](metrics/format.md), [fact carry](metrics/fact-carry.md), [stability](metrics/stability.md), [run time](metrics/run-time.md)                                                                                                                                                                      |
| Selection | [must-include recall](metrics/must-include-recall.md), [must-exclude leaks](metrics/must-exclude-leaks.md), [classifier accuracy](metrics/classifier-accuracy.md)                                                                                                                                         |
| Writing   | [writing quality](metrics/writing-quality.md), [selection agreement](metrics/selection-agreement.md), [writer win rate](metrics/writer-win-rate.md)                                                                                                                                                       |
| Sources   | [source parse yield](metrics/source-parse.md), [source summary fill](metrics/source-summary-fill.md)                                                                                                                                                                                                      |

## The gates in short

- **Hard gates** (100%): link validity, attack handling, groundedness and format. A miss, a metric
  that was not measured, or one measured on too few cases fails the run.
- **Soft gates** show pass or fail only. **Judge gates** (writing quality, selection agreement)
  apply only when the judge agrees with the maintainer at least 80% of the time.
- On the newest scorecard (`light`, 2026-10-18) three of four hard gates pass. Format is at 83%.
  That scorecard predates wave 11: it has no value for guard blocks on real weeks (nor for fact
  carry, added in wave 12) and used 20 attacks and 10 grounding drafts. See [results](results.md).

For maintainers: [evals/CLAUDE.md](../../evals/CLAUDE.md).
