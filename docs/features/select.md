# Select

Part of [Features](README.md).

## What it is for

Each writer in the panel produces one draft. After the checks and the output guards, more than one
draft can be left. This step picks the one that goes out. A judge model scores each passing draft
against its own source items, and the best mean score wins. If the judge cannot decide, the run
still goes on with a fixed, predictable choice.

## Where it sits

It is the seventh step, after guardOutput and before deliver. See
[data flow](../architecture/data-flow.md).

## What it does

- Runs only when the profile has a judge and two or more drafts passed. Otherwise the first
  passing draft, in writer order, wins and no judge call is made.
- Scores every draft with one call per draft, one after another. The judge sees one draft and only
  its own source items. It never sees another draft or the writer's name, so no score can be
  pulled by a neighbour.
- Asks four questions, each on a scale of 1 to 5: `accuracy`, `clarity`, `whyItMatters` and
  `focusFit`. The overall score is the mean. Every draft gets the same wording.
- Reads a fixed plain-text form of the digest, not the Markdown, so a new layout does not move the
  scores and old eval results stay comparable.
- The highest mean wins. A tie goes to the writer listed first in the panel.
- If the judge fails or gives an unusable answer, the run does not fail. The first draft in writer
  order wins, with no scores and a warning in the log.
- The scores are stored with each draft in `run.json`. A draft with no score means the judge did
  not score it.
- Draft and source text is untrusted. It is wrapped as data, and logs hold only writer tags and
  scores, never draft text.

## What you can configure

- The judge model comes from the profile: only `quality` has one by default. A `models.writers`
  list of two or more tags gets a judge too, and one tag turns the judge off. See
  [judge](../configuration/judge.md) and [set the judge](../runbooks/configure/set-the-judge.md).
- `models.timeoutsMs.judge` (default 120 s), `models.retries`, `models.seed`. See
  [models](../configuration/models.md).
- `focusAreas` appears in the `focusFit` question. See [focus areas](../configuration/focus-areas.md).
- The four criteria and the 1 to 5 scale are fixed in code. All keys:
  [config keys](../reference/config-keys.md).

## What can go wrong

- The judge times out or is not installed. The run keeps going with the first writer, so the
  digest is valid but not judged. Look for a warning in the logs and for drafts without a score in
  `pnpm digest show <week> --part run`. See [read logs](../runbooks/observe/read-logs.md).
- The judge's pick looks wrong. Compare the scores and the drafts with
  `pnpm digest show <week> --part drafts`. Judge quality is measured by
  [selection agreement](../evaluation/metrics/selection-agreement.md) and
  [writing quality](../evaluation/metrics/writing-quality.md).
- A missing judge model also stops the run at the start, with "missing models". See
  [failed run](../runbooks/debug/failed-run.md).
- If no draft passed, the week is `blocked` before this step. See
  [blocked run](../runbooks/debug/blocked-run.md).

## Code and tests

- Folder: [src/select/](../../src/select/). Maintainer notes: [CLAUDE.md](../../src/select/CLAUDE.md).
- No port of its own. It calls the model port of [models](models.md) with the role `judge`.
- Tests sit next to the code and script the judge's answers with a fake model provider.

## Related

- Before: [guards](guards.md) (output). After: [delivery](delivery.md).
- The plain text the judge reads comes from [render](render.md).
- The judge is calibrated against the maintainer in [evals](evals.md); the rubric is written down
  in the evals folder.
