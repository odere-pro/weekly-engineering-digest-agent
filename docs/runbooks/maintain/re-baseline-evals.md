# Re-baseline evals

Part of [Runbooks](../README.md) / Maintain.

## Purpose

Record a fresh scorecard for a profile and update the pages that quote it, so the written
baseline matches what the code does today.

## When to use

- After a change to a prompt, a threshold, a model, a guard, a writer or a fix that moves quality.
- Before a [release](../release/cut-a-release.md), when the last baseline is older than the fixes.
- After you [add an eval case](add-eval-case-from-a-bad-week.md): old scorecards measured a
  smaller set and no longer compare. The saved scorecard (2026-10-18) predates wave 11: it has 16
  metrics, 20 attacks and 10 grounding drafts, and measured the classifier the old way. The next
  full run is the first with 18 metrics (guard blocks on real weeks and fact carry), 30 and 30 cases, the
  rule guard on and the within-one classifier measure, so it is a new baseline, not a like-for-like
  repeat.
- To just look at the numbers once, use [Run evals](../run/run-evals.md).

## Prerequisites

- A maintainer on a clone (this edits files that are committed), on a quiet machine with the
  profile's models pulled. `light` took about 110 minutes on the last full run; the data has since
  grown to 30 attacks and 30 grounding drafts, so allow longer. Only `light` has a baseline.
- `pnpm check` passes first, so a red scorecard is not a broken build.
- A config without `models.writers`, so the writers are the profile's own.
- Know today's files: `ls evals/scorecards`. The name is `<UTC date>-<profile>.json`.

## Steps

1. If a scorecard for today and this profile exists, keep it. A second run on the same day
   overwrites it, and `evals/scorecardCompat.test.ts` reads `2026-10-17-light.json`, so that file
   must stay. The repo keeps an earlier run as `2026-10-17-light-wave5.json`.

   ```bash
   cp evals/scorecards/<date>-light.json evals/scorecards/<date>-light-before.json
   ```

2. Run the eval for one profile. `EVAL_JUDGE` is optional and scores writing quality. A baseline
   needs the **full** run: a `--only` run saves a partial scorecard, which is not a baseline.

   ```bash
   EVAL_JUDGE=clef:latest pnpm digest eval --profile light
   ```

   If the run is lost half way, finish it from the saved week replays. Use the same checkout,
   config and models, or the replays run again. Details:
   [Running parts of the eval](../../evaluation/running-sections.md).

   ```bash
   EVAL_JUDGE=clef:latest pnpm digest eval --profile light --resume
   ```

   To see what moved against the previous baseline, compare the two files. It runs nothing.

   ```bash
   pnpm digest eval --compare evals/scorecards/<old>.json evals/scorecards/<new>.json
   ```

3. Check that every saved scorecard still parses, old ones included.

   ```bash
   pnpm vitest run evals/scorecardCompat.test.ts
   ```

   A field you add to the scorecard schema must be optional, or the old files fail here.

4. Update the pages that quote the baseline:
   - [Current results](../../evaluation/results.md): numbers, date, models, file name, and the
     "Current result" line on each metric page (18 pages, including
     [guard blocks on real weeks](../../evaluation/metrics/guard-real-blocks.md), which has no value
     until this run). Its last section lists the steps.
   - [Status and limits](../../overview/status-and-limits.md), the `README.md` status section and
     the "Known limits" of `CHANGELOG.md` under `[Unreleased]`.
   - [Cost and hardware](../../overview/cost-and-hardware.md) if the run time moved.
5. Run `pnpm check`, then commit the new scorecard and the page changes together.

## Verify

- The file `evals/scorecards/<today>-<profile>.json` exists and is the newest by name.
- Its numbers equal the table the command printed, and the results page quotes the same file.
- `pnpm vitest run evals/scorecardCompat.test.ts` and `pnpm check` are green.
- A red hard gate (`Hard gates: FAIL`, exit 1) is a result to record, not a failure of this task.

## Roll back

Delete the new scorecard (or restore the copy from step 1), and revert the page edits with
`git restore docs/evaluation README.md CHANGELOG.md docs/overview`. Nothing else is written; the
replay uses an in-memory store and sends nothing.

## Troubleshooting

| Symptom                                                        | Cause                                  | Fix                                                                   |
| -------------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------- |
| The old numbers are gone                                       | A same-day run overwrote the file      | Restore with `git restore evals/scorecards/<file>`; copy before runs. |
| `scorecardCompat` fails on an old scorecard                    | A new field is required                | Make it optional in `evals/schema.ts`.                                |
| `The eval judge "..." (EVAL_JUDGE) is not installed in Ollama` | The judge tag is not pulled            | `ollama pull <tag>` or unset `EVAL_JUDGE`.                            |
| The run is interrupted after an hour                           | The machine slept, or Ollama restarted | Run again with `--resume`; the scorecard is written only at the end.  |
| Numbers differ from the last run with no change                | Different config or judge              | Compare `models` and `Judge agreement` in the two files.              |

## Related

- [Run evals](../run/run-evals.md), [Current results](../../evaluation/results.md), [Gates](../../evaluation/gates.md)
- [Running parts of the eval](../../evaluation/running-sections.md)
- [How evals work](../../evaluation/how-evals-work.md), [Add an eval case](add-eval-case-from-a-bad-week.md)
- [evals/CLAUDE.md](../../../evals/CLAUDE.md)
