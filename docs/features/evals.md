# Evals

Part of [Features](README.md).

## What it is for

Evals measure whether the digest is good, offline and the same way every time. The `evals/` folder
holds the frozen test data (recorded weeks, labelled classifier items, attack and grounding drafts,
recorded feed responses) and the harness that replays the pipeline over it and scores the result.
`digest eval` runs it and prints a scorecard. If a hard gate fails, the command exits with 1.

## Where it sits

It is outside the weekly pipeline: a tool that runs the real pipeline code over recorded data. It
is not in the data flow of a normal run. See [feature folders](../architecture/feature-folders.md).

## What it does

- Loads and checks every case file. A bad file stops the eval with an error that names it.
- Runs the real RSS and GitHub fetchers over recorded feed responses, with no network and no model.
- Replays a dry run of the digest for each recorded week (6 weeks, 2026-W36 to W41). A fixed clock,
  every guard on, nothing delivered, `topN` 5, and the template fallback digest off so a rejected
  week stays visible. Every week runs 3 times to measure stability (the gate uses the first
  week), and the first week runs once more with all the attack items mixed in.
- Asks every input guard about every attack item on its own (independent recall), so the order of
  the guards no longer hides one of them.
- Runs the classifier cases (60 labelled items) and the grounding drafts (30, each with one planted
  false claim and a clean control). 30 attack items test the input guards. In each set the last
  ten cases are held out: no one tunes on them.
- Scores the winning digests with a judge model when the profile has none and `EVAL_JUDGE` names
  one. It runs last, so the judge model loads once.
- Turns the results into 18 measurements and a scorecard, including how often the output guards
  blocked a real week. **Hard gates** must be 100%: link
  validity, attack handling, groundedness and format. A hard gate that was not measured, or was
  measured on too few cases, also fails. **Soft gates** show pass or fail only. Some measures are
  only reported. Judge-based gates apply only after the judge agrees with the maintainer.
- Saves `evals/scorecards/<date>-<profile>.json`. The newest is `2026-10-18-light.json`, which
  predates wave 11 (20 attacks, 10 grounding drafts, 16 metrics).
- People own the labels. The recorders never overwrite them. A separate script merges the files
  that `digest feedback` writes into a week's labels; it only adds labels and reports conflicts.

## What you can configure

- `pnpm digest eval --profile <name>` picks `quality`, `fast`, `light` or `all`. The default is
  the profile in your config.
- `--only <section>` runs `guards`, `classify`, `sources` or `weeks` alone and saves a partial
  scorecard. `--resume` reuses the week replays a lost run saved. `--compare <files...>` compares
  two saved scorecards and runs nothing. See [running parts of the eval](../evaluation/running-sections.md).
- `EVAL_JUDGE` in the environment: a model tag used to score profiles with no judge. See
  [environment](../configuration/environment.md).
- The gates and the case counts are fixed in code and data. See [gates](../evaluation/gates.md).
- Everything else about running and reading evals is in the [evaluation section](../evaluation/README.md).

## What can go wrong

- A hard gate fails and `eval` exits 1. Read the metric page, for example
  [link validity](../evaluation/metrics/link-validity.md) or
  [attack handling](../evaluation/metrics/attack-handling.md). See
  [how evals work](../evaluation/how-evals-work.md) and [results](../evaluation/results.md).
- The judge model is not installed. The eval stops and does not pull it for you.
- A partial run (`--only`) never fails the command, even when its section is red. Read its gates.
- Evals use real models, so they are slow and need the machine to yourself. See
  [run evals](../runbooks/run/run-evals.md).
- Recorded data goes stale after a feed change or a URL normalisation change. See
  [re-baseline evals](../runbooks/maintain/re-baseline-evals.md).
- A bad real week is the best new case. See
  [add an eval case from a bad week](../runbooks/maintain/add-eval-case-from-a-bad-week.md) and
  [adding cases](../evaluation/adding-cases.md).

## Code and tests

- Folder: [evals/](../../evals/). Maintainer notes: [CLAUDE.md](../../evals/CLAUDE.md).
- No port. The data lives in subfolders next to the code: recorded weeks, classifier cases,
  attacks, grounding drafts, recorded sources, scorecards and the judge rubric.
- Tests sit next to the code. Data tests fail when a case file breaks its rules. No test calls a
  model.

## Related

- [cli](cli.md) runs it with `digest eval`. [app](app.md) builds the pipeline it replays.
- It replays [sources](sources.md), [classify](classify.md), [guards](guards.md),
  [checks](checks.md) and [select](select.md).
- Data sets: [recorded weeks](../evaluation/sets/recorded-weeks.md) and
  [attacks](../evaluation/sets/attacks.md).
