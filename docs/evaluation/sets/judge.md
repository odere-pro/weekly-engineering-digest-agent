# Judge and calibration

Part of [Eval sets](README.md).

A model judge scores digests. This page covers what the judge scores, how a profile without a
judge gets one for the eval, and how a person checks that the judge can be trusted.

## What the judge scores

One draft at a time, on four criteria, each from 1 (poor) to 5 (excellent): accuracy against the
sources, clarity, why it matters, and focus fit. The overall score is the mean of the four. The
words for each score are in [evals/rubric.md](../../../evals/rubric.md). Keep it in step with
`src/select/judgePrompt.ts`, which holds the questions the model sees.

## Where it runs

| Profile                      | Judge                                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------------- |
| `quality` (two writers)      | `clef:latest`. The select step scores every draft, and the eval reads the winner's score |
| `fast`, `light` (one writer) | None. The select step is skipped                                                         |

For a profile without a judge, set `EVAL_JUDGE` (in `.env` or the shell) to a model tag, for
example `EVAL_JUDGE=clef:latest`. `evals/judge/evalJudge.ts` then builds a judge with the same
rubric and scores each week's winning digest after every replay has finished, so the judge model
loads once. The digest is read back from the Markdown on disk.

- Before anything is replayed, `assertJudgeInstalled` checks that Ollama answers, that the tag is
  installed and that it has the `decision` capability. It never pulls a model. A failure stops the
  run with exit code 1 and a message that names the tag.
- A week the judge cannot score is listed in the note (`judge failed on 2026-W38`). The other
  weeks keep their scores. A week without a digest is skipped.
- The scorecard names the model as `evalJudge` in its `models` section.

See [judge configuration](../../configuration/judge.md) and
[set the judge](../../runbooks/configure/set-the-judge.md).

## Metrics it feeds

- [Writing quality](../metrics/writing-quality.md): the mean score of the winning digests.
- [Selection agreement](../metrics/selection-agreement.md): how often the judge picks the draft
  the maintainer picks. It is read from the calibration file, not measured on every run.
- The scorecard header shows the judge agreement, or `not calibrated`.

## The 80% rule

The judge's scores are gated only when it agrees with the maintainer at least 80% of the time:
`judgeAgreement` in `calibration.json` is the share of hand-graded digests where the judge is within
half a point of the grade. Below 80%, or with no file, the scores are shown and not gated.
No `calibration.json` is committed yet, so both gates are reported only. The file is read only for
a profile that has its own judge, so on `light` and `fast` the gates stay off. See [gates](../gates.md).

## Calibrating the judge

1. After each `quality` run (a dry run counts), add its drafts to the sheet:

   ```bash
   pnpm exec tsx evals/judge/runDrafts/addRun.ts dist/2026-10-19/digest
   ```

   It saves every draft the judge scored as `evals/judge/<week>/<writer>.md`, exactly as the run
   printed it, and fills `week`, `writer` and `draft` in the next free rows of
   `evals/judge/grades.json` (started from `grades.template.json`). The judge's scores go to
   `evals/judge/scores/<week>.json`, not into the sheet. A week is added once: adding the same run
   again only fills in missing files, and another run of the same week is refused.

2. Grade each draft: read the sources, then the draft, and set `humanGrade` from 1 to 5. Under
   `picks`, add `{ "week": "2026-W43", "better": "<writer tag>" }` for each week where you
   compared two drafts. Delete rows you do not use.
3. Reveal the judge's scores. A week's scores appear only once every draft of that week has a
   grade, so one score cannot sway the grade of its rival:

   ```bash
   pnpm exec tsx evals/judge/runDrafts/addRun.ts --reveal
   ```

4. Run the calibration. It calls no model.

   ```bash
   pnpm exec tsx evals/judge/calibrate.ts
   ```

   It reads `evals/judge/grades.json` and writes `evals/judge/calibration.json`. Both paths can be
   given as arguments, and `--min-digests N` accepts a sheet with fewer than 10 rows.

The output shows the judge agreement, the selection agreement, the Spearman rank correlation and
the mean absolute difference, and says whether the judge scores are now gated. A sheet with
missing values is refused and the message lists them. Selection agreement needs digests from two
writers for each picked week. If the judge scores two drafts equally, that counts as a
disagreement.

## Rules

- Read the sources first, then the draft. Do not look at the judge's score before you grade.
- Penalise invented facts first: one made-up number makes it a 2 on accuracy.
- The file holds the maintainer's judgement. Do not edit `humanGrade` to make the judge pass.
