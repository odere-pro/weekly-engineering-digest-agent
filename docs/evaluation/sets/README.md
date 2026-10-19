# Eval sets

Part of [Evaluation](../README.md).

An eval set is a folder of frozen test data under `evals/`. `digest eval` reads all of them. Each
page below says what the set holds, why it exists, which metrics it feeds and how to refresh it.

| Page                                      | Data                                     | Size                                       | Feeds                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------- | ---------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Recorded weeks](recorded-weeks.md)       | `evals/weeks/`                           | 6 weeks, 369 items                         | [link validity](../metrics/link-validity.md), [format](../metrics/format.md), [fact carry](../metrics/fact-carry.md), [recall](../metrics/must-include-recall.md), [leaks](../metrics/must-exclude-leaks.md), [false blocks](../metrics/guard-false-blocks.md), [run time](../metrics/run-time.md), [writer win rate](../metrics/writer-win-rate.md) |
| [Stability runs](stability.md)            | the recorded weeks, replayed three times | 18 replays                                 | [stability](../metrics/stability.md), [guard blocks on real weeks](../metrics/guard-real-blocks.md)                                                                                                                                                                                                                                                  |
| [Classifier cases](classifier-cases.md)   | `evals/classifier-cases.json`            | 60 labeled items                           | [classifier accuracy](../metrics/classifier-accuracy.md)                                                                                                                                                                                                                                                                                             |
| [Attack cases](attacks.md)                | `evals/attacks/`                         | 32 fake items (10 held out)                | [attack handling](../metrics/attack-handling.md), [guard attack recall](../metrics/guard-attack-recall.md)                                                                                                                                                                                                                                           |
| [Grounding cases](grounding.md)           | `evals/grounding/`                       | 30 drafts with a false claim (10 held out) | [groundedness](../metrics/groundedness.md), [guard false blocks](../metrics/guard-false-blocks.md)                                                                                                                                                                                                                                                   |
| [Source recordings](source-recordings.md) | `evals/sources/`                         | 24 recorded feeds                          | [source parse yield](../metrics/source-parse.md), [source summary fill](../metrics/source-summary-fill.md)                                                                                                                                                                                                                                           |
| [Judge and calibration](judge.md)         | `evals/judge/`, `evals/rubric.md`        | 10 hand-graded digests                     | [writing quality](../metrics/writing-quality.md), [selection agreement](../metrics/selection-agreement.md)                                                                                                                                                                                                                                           |

## How the sets relate

- The attack replay is the first recorded week plus the attack items. Attack ids and URLs must
  differ from every recorded item.
- Real items in the classifier cases are copied unchanged from the recorded weeks.
- The threshold sweep (`evals/tuneThresholds.ts`) reads the weeks, the classifier cases, the
  attacks and the grounding drafts. See [classifier cases](classifier-cases.md#tuning-the-thresholds).
- The classifier cases, the weeks and the attacks also feed the threshold sweep and the relevance
  calibration (`evals/calibrate.ts`). See [classifier cases](classifier-cases.md#calibrating-the-relevance).
- Synthetic data uses invented companies and `.example` hosts, so the eval never names or
  contacts a real site.

## Rules for all sets

Ids are hashes of the URL, people own the labels, recorded feed bodies are untrusted text and
the held-out cases (attacks 21 to 30, grounding 21 to 30) are never used to tune. The full list and the test files are in
[adding cases](../adding-cases.md). Gates: [gates](../gates.md).
