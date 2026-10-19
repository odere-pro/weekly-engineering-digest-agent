# Add an eval case from a bad week

Part of [Runbooks](../README.md) / Maintain.

## Purpose

Turn a week where the digest got something wrong into test data, so a fix can be measured and the
mistake shows up in the next scorecard if it comes back.

## When to use

- A wrong item was picked, a good item was missed, the classifier misjudged an item, or an
  injection or a made-up claim reached the digest.
- The rules for each set are in [Adding cases](../../evaluation/adding-cases.md). This runbook
  covers the path from a real week to a case.
- A run that simply failed is not a case: see [Failed run](../debug/failed-run.md).

## Prerequisites

- A maintainer. **People own the labels.** The tools only add labels and print conflicts. A model
  may propose a label; you decide and review it.
- The run folder `data/runs/<week>/` still exists. Folders older than `keepWeeks` keep only
  `digest.md`, so do this before pruning.
- Do not change a prompt, a threshold or a model first. Keep the evidence, then change one thing.

## Steps

1. Copy the evidence out of `data/`, for example `cp -R data/runs/<week> ~/bad-weeks/<week>`.
2. See what happened: `pnpm digest show <week> --part scores` (which items were scored and which made the digest),
   `--part drafts` (what each writer wrote and why it was rejected), `--part items`.
3. Pick the case type.

   | What went wrong                            | Case            | Add it by                                                                                                |
   | ------------------------------------------ | --------------- | -------------------------------------------------------------------------------------------------------- |
   | A wrong item was picked, a good one missed | Week labels     | Tick `review.md`, then steps 4 to 6                                                                      |
   | Wrong area or relevance for an item        | Classifier case | An entry in `evals/classifier-cases.json`: [classifier cases](../../evaluation/sets/classifier-cases.md) |
   | An injection got past the input guards     | Attack          | A new file in `evals/attacks/`: [attacks](../../evaluation/sets/attacks.md)                              |
   | A false claim got past the output guard    | Grounding       | A new file in `evals/grounding/`: [grounding](../../evaluation/sets/grounding.md)                        |

4. Tick the review sheet. Open `data/runs/<week>/review.md`. Tick `[x]` a picked item that should
   not have been there, and a candidate that should have been. Change nothing else: an edited
   item line is refused with its line number.
5. Turn the ticks into a feedback file.

   ```bash
   pnpm digest feedback 2026-W43
   ```

   ```text
   2026-W43: 1 wrong pick, 2 missed -> data/feedback/2026-W43.json
   ```

6. Merge it into the labels of the same week id. Missed items become `mustInclude`, wrong picks
   become `mustExclude`. An existing label is never overwritten; a disagreement prints
   `CONFLICT <id>: ...` and is left for you.

   ```bash
   pnpm tsx evals/feedbackToLabels.ts 2026-W43
   ```

7. Fix the labels by hand: `evals/weeks/<week>/labels.json` needs exactly 5 `mustInclude` ids
   (the tool warns when it does not), and a `notes` string such as
   `agent-proposed, maintainer-reviewed 2026-10-19` once you have reviewed it.
8. Run the data tests, then everything.

   ```bash
   pnpm vitest run evals
   ```

**Check the week id first.** A run is named after the week it started in, but a Monday run collects
the week before. A folder in `evals/weeks/` may hold only items published in its own ISO week, or
the loader stops with `N item(s) were not published in <week>`. `feedbackToLabels` is safe when
`evals/weeks/<week>/` already exists for that id. When it does not, the tool builds the folder from
the run's `items.json` and that folder fails to load. Record the real week first
(`pnpm eval:record`, see [recorded weeks](../../evaluation/sets/recorded-weeks.md)) and add the ids
to its `labels.json` by hand. The ids are the same in both places.

The tests pin the set sizes (6 weeks, 20 attacks, 10 grounding drafts, 60 classifier cases), so a
new case also changes the count in its `evals/dataset.*.test.ts`. Never tune a guard prompt on the
held-out attacks 11 to 20. Use `.example` hosts in invented cases and keep real secrets out.

## Verify

- `pnpm vitest run evals` and `pnpm check` are green.
- The tests load every case file through the real eval loader, so a bad file fails with its name.
  The next full `digest eval` run prints the new counts on its `Cases:` line.
- The labels diff (`git diff evals/weeks`) shows only the ids you meant.

## Roll back

`git restore evals/` and delete `data/feedback/<week>.json`. Labels are only ever added, so the
restore removes exactly what you added. Your copy from step 1 is untouched.

## Troubleshooting

| Symptom                                                                 | Cause                                          | Fix                                         |
| ----------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------- |
| `No review sheet for <week>: run the week first (...)`                  | No `review.md`; the week was pruned or not run | Use your copy from step 1, or run the week. |
| `CONFLICT <id>: feedback says missed, but labels say must-exclude`      | You and an earlier label disagree              | Decide by hand; edit `labels.json`.         |
| `WARNING: <week> has N must-include ids; digest eval expects exactly 5` | Merge went above or below 5                    | Trim or complete the list by hand.          |
| `Run digest feedback <week> first: cannot read ...`                     | Step 5 was skipped                             | Run `digest feedback <week>`.               |
| `Cannot create the week folder: no items.json to copy at ...`           | The run folder was pruned                      | Restore your copy into `data/runs/<week>/`. |
| `N item(s) were not published in <week>`                                | The week folder holds items from another week  | See "Check the week id first".              |

## Related

- [Adding cases](../../evaluation/adding-cases.md), [Recorded weeks](../../evaluation/sets/recorded-weeks.md)
- [Re-baseline evals](re-baseline-evals.md), [Missing or wrong item](../debug/missing-or-wrong-item.md)
- [evals/CLAUDE.md](../../../evals/CLAUDE.md)
