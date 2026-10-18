# Judge rubric

The judge scores one digest draft at a time on four criteria, each from 1 (poor) to 5
(excellent). The overall score is the mean of the four. The maintainer grades the 10 calibration
digests by hand (`evals/judge/`) with the same rubric, so judge and maintainer are measured
against the same words.

The judge's questions live in `src/select/judgePrompt.ts` (`buildJudgeQuestions`). This file
says what each score means; keep the two in step.

## Criteria

### Accuracy

Is every claim supported by the source items the draft cites? Version numbers, names, dates and
features must appear in the source.

| Score | Meaning                                                              |
| ----- | -------------------------------------------------------------------- |
| 5     | Every claim is in the sources. Nothing is added or stretched.        |
| 4     | Everything is supported; one phrase goes slightly beyond the source. |
| 3     | Mostly supported; one claim is vague or only loosely backed.         |
| 2     | A claim the sources do not make, or a wrong detail.                  |
| 1     | Several unsupported claims, or an invented fact, number or link.     |

### Clarity

Is the digest easy to read, specific and short? Marketing language, filler and repetition lower
the score.

| Score | Meaning                                                                         |
| ----- | ------------------------------------------------------------------------------- |
| 5     | Plain, specific and tight. An engineer gets each item in one read.              |
| 4     | Clear, with a little filler or a clumsy sentence.                               |
| 3     | Understandable, but generic in places or longer than it needs to be.            |
| 2     | Vague or padded; the reader has to guess what changed.                          |
| 1     | Hard to follow, full of hype, or the summaries repeat the titles word for word. |

### Why it matters

Does each item say why an engineer should care, in terms that fit that item?

| Score | Meaning                                                                |
| ----- | ---------------------------------------------------------------------- |
| 5     | Concrete and specific: what to do, what breaks, or what gets easier.   |
| 4     | Specific for most items; one is a little general.                      |
| 3     | A reason is given, but it could fit many releases.                     |
| 2     | Mostly generic ("this is an important update") or repeats the summary. |
| 1     | Missing, or wrong for the item.                                        |

### Focus fit

Does every item belong to one of the reader's focus areas (from `digest.config.json`)?

| Score | Meaning                                                               |
| ----- | --------------------------------------------------------------------- |
| 5     | Every item is squarely inside a focus area, and the areas are spread. |
| 4     | All items fit; one is at the edge of an area.                         |
| 3     | One item is only loosely related to the focus areas.                  |
| 2     | Several items are off focus.                                          |
| 1     | The digest is mostly outside the focus areas.                         |

## How the scores are used

- **Writing quality**: the judge's overall score for the selected draft, averaged over the
  recorded weeks. Gate: mean 3.5 or more.
- **Selection agreement**: how often the judge's pick between two drafts matches the
  maintainer's. Gate: 70% or more.
- **Judge agreement**: how often the judge's overall score is within half a point of the
  maintainer's grade for the same digest. Measured once, on the 10 hand-graded digests, and
  stored in `evals/judge/calibration.json`.

If judge agreement is below 80%, or there is no calibration file, the judge's scores are
reported on the scorecard but the two judge gates are not enforced.

## Grading by hand

1. Read the sources first, then the draft. Do not look at the judge's score before you grade.
2. Score the four criteria on their own, then take the mean as the overall grade.
3. When a week has two drafts, pick the one you would send; note it next to the grades.
4. Penalize invented facts first. A fluent draft with one made-up number is still a 2 on accuracy.
