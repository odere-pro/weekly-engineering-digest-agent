# Classify

Part of [Features](README.md).

## What it is for

The digest can carry only 3 to 5 items, so every item the rule guard kept needs a score.
This step gives each item four judgements: how relevant it is (0 to 3), which focus area it
belongs to, how likely it is hype, and how likely it is a minor release. It drops nothing. The
process step applies the thresholds later.

## Where it sits

It is the third step, after guardInput and before process. See
[data flow](../architecture/data-flow.md).

## What it does

- Makes one model call per item, one at a time, using the `classify` role. With no items it makes
  no call.
- Asks four questions about each item:
  - `relevance`: an expected level from 0 to 3;
  - `area`: one of your focus areas or `other`, with a confidence;
  - `hype`: the probability that the item is mainly hype or marketing;
  - `minorRelease`: the probability that it is a small release with only fixes.
- Shows the model the item only inside an untrusted-data block, so text in a feed cannot give it
  orders. A source's `area` goes in as a one-line hint outside that block.
- By default it reads items that only the rule guard has checked: the model input guards run
  later, on the picks (`guardCandidates`). The classifier is the one model that does this. It
  reads one item per call, answers only fixed choices and probabilities, and writes no text. A
  crafted item can at most raise its own score, which makes it a pick, and then the model guards
  check it. See [safety](../architecture/safety.md#which-models-read-an-unchecked-item).
- Fails loudly on a bad answer. A missing, wrongly typed or out-of-range answer, or an area that
  is not one of the options, fails the run at step `classify`. It never falls back to a default.
- Logs a `Progress` line every 25 items or minute (items done, total, time left), so a slow model
  is not an hour of silence. See [observability](../operations/observability.md).
- Returns the scored items in input order. The scores are saved as `scores.json` in the run folder.
  `pnpm digest show <week> --part scores` prints them as a table.
- A "generate" mode for models without decision support exists in the code but does not run in a
  real week. Re-scoring with the writer model runs only when `models.rescoreWithWriter` is `true`
  (off by default), in `digest run` and `digest eval`: the writer model scores the items at or
  above `thresholds.minRelevance` a second time. With it on, the model input guards run in
  `guardInput` on every item, so the writer model never reads an item they did not check.

## What you can configure

- `focusAreas`: 1 to 25 unique topics. The classifier sorts items into them, plus `other`. See
  [focus areas](../configuration/focus-areas.md).
- The optional `area` field of a source is a hint. See [sources](../configuration/sources.md).
- The model comes from the profile (role `classify`). See [profiles](../configuration/profiles.md).
- `models.timeoutsMs.classify` (default 60 s), `models.retries` and `models.seed`. See
  [models](../configuration/models.md).
- The cut-offs for relevance, hype and minor releases are `thresholds` values used by
  [process](process.md). See [thresholds](../configuration/thresholds.md).
- All keys: [config keys](../reference/config-keys.md). Runbook:
  [change focus areas](../runbooks/configure/change-focus-areas.md).

## What can go wrong

- The model call fails or times out: the run is `failed` with step `classify`. See
  [failed run](../runbooks/debug/failed-run.md) and
  [slow model or out of memory](../runbooks/debug/slow-model-or-out-of-memory.md).
- An item is scored badly, so a good item is dropped or a weak one is kept. Check its row in
  `digest show <week> --part scores`. See
  [missing or wrong item](../runbooks/debug/missing-or-wrong-item.md). To keep the case for later,
  see [add an eval case from a bad week](../runbooks/maintain/add-eval-case-from-a-bad-week.md).
- Changing a focus area changes where items land. Measure the effect with
  [classifier accuracy](../evaluation/metrics/classifier-accuracy.md).

## Code and tests

- Folder: [src/classify/](../../src/classify/). Maintainer notes: [CLAUDE.md](../../src/classify/CLAUDE.md).
- No port of its own. It calls the model port of [models](models.md) with the role `classify`.
- Tests sit next to the code and use a fake model provider from [test/fakes](../../test/fakes/).

## Related

- Before: [guards](guards.md) (guardInput). After: [process](process.md).
- The decision calls run through [models](models.md).
- Focus areas come from [config](config.md).
