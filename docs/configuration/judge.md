# Judge

Part of [Configuration](README.md).

The judge is the model that picks the best digest when more than one writer drafted one. It has
no config key of its own. Whether you have a judge depends on the [profile](profiles.md) and on
`models.writers`.

## What it does

After the checks and the output guards, the `select` step has the drafts that passed. If two or
more passed and a judge exists, the judge scores each draft:

1. One call per draft, in turn (role `judge`, a decision-model call). The judge sees one draft in
   plain text and only the source items that draft cites. It never sees another draft or the
   writer's name, so one score cannot pull on another.
2. Four criteria, each scored 1 to 5: `accuracy`, `clarity`, `whyItMatters` and `focusFit`
   (how well the digest fits your [focus areas](focus-areas.md)).
3. The draft's score is the mean of the four. The highest mean wins. A tie goes to the writer
   listed first.

Scores are saved in `run.json` on each draft (`score` and `byCriterion`).
`pnpm digest show <week> --part drafts` shows them in the `Judge` column.

## Who has a judge

| Setup                                  | Judge                                         |
| -------------------------------------- | --------------------------------------------- |
| `quality` (two writers)                | `clef:latest`                                 |
| `fast`, `light`, the fallback          | none (one writer each)                        |
| `models.writers` with one tag          | none, on every profile                        |
| `models.writers` with two or more tags | the profile's judge, or `clef:latest` if none |

```json
{
  "profile": "light",
  "models": {
    "writers": ["gemma4:e4b-mlx", "nemotron-3.5-lightning:30b-mlx"]
  }
}
```

That file gives `light` two writers, so the judge is `clef:latest`. Pull it first, and expect a
longer run: each writer drafts, and the judge scores each draft.

## When select is skipped

The step makes no judge call, and the first passing draft in writer order wins, when:

- the profile has no judge (one writer), or
- only one draft passed the checks and guards.

If the judge fails (a timeout, or an answer that cannot be read), the run does not fail. The
first passing draft in writer order wins, no scores are saved and a warning is logged. The judge
timeout is `models.timeoutsMs.judge`, 120000 ms by default.

## `EVAL_JUDGE` is a different thing

`EVAL_JUDGE` is an environment variable for `digest eval` only. On a profile with no judge, it
names a model that scores the winning digest of each replayed week, so the writing-quality
metric has a value. The score is reported, not gated, until the judge is calibrated. `digest
run` ignores it. If the tag is not installed, or is not a decision model, `eval` stops with exit
1 before it replays anything. Set it in `.env`: see [environment](environment.md).

## Change it

- [Set the judge](../runbooks/configure/set-the-judge.md)
- [Change models or writers](../runbooks/configure/change-models-or-writers.md)
- [Run the evals](../runbooks/run/run-evals.md)

## Related

- [Select feature](../features/select.md)
- [Selection agreement metric](../evaluation/metrics/selection-agreement.md) and
  [writing quality metric](../evaluation/metrics/writing-quality.md)
- [Judge eval set](../evaluation/sets/judge.md)
- [src/select/CLAUDE.md](../../src/select/CLAUDE.md)
