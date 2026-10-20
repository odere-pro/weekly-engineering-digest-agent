# Guards

Part of [Features](README.md).

## What it is for

Collected text and model drafts are untrusted. Guards are the safety checks: four ask a model and
one is a table of fixed rules in code. Input guards look at collected items: the rule guard reads
every item before any model does, and the model input guards check the picks before any model that
writes text sees them. Output guards look at each draft. They catch prompt injection, harmful
content, claims the sources do not support, off-task text and hype. Config can switch a guard off.
The link check and format check are not guards: see [checks](checks.md).

## Where it sits

It runs three times: guardInput right after collect (the rule guard), guardCandidates after
process and before write (the model input guards), and guardOutput after write and before select.
See [data flow](../architecture/data-flow.md).

## What it does

- Four model checks. Input: `clefPolicy` (is the item aimed at an AI system, or harmful?) and
  `graniteRisk` (Granite Guardian is asked about jailbreak, then harm). Output:
  `graniteGroundedness` (each digest item against its own source, then the headline and intro
  against the cited sources) and `clefRubric` (is the draft off-task, hype or harmful?).
- One rule check, `ruleInjection` (input). It runs first and makes no model call: fixed rules flag
  orders to the AI, fake role lines, chat tokens, hidden characters, script URLs and off-host links
  that give an order. Its verdict reason lists rule ids only, for example `ruleInjection: ignorePrevious`.
  An item it flags never reaches the model guards, in either mode. See
  [the rule guard](../configuration/guards.md#the-rule-guard-ruleinjection).
- The input side is split in two steps. `guardInput` runs only the rule guard, on every collected
  item. `classify` scores the items it kept, and `process` picks the top N. Then `guardCandidates`
  runs `clefPolicy` and `graniteRisk` on those picks, in the configured mode.
- In `guardCandidates`, a flagged pick is removed, `process` runs again without it, and the items
  it now picks are checked. After a flag, the batch is topped up to N items with the next-ranked
  eligible items, so several replacements cost one more batch. This repeats until every pick has
  passed or no eligible item is left. Fewer than 3 items left ends the week `quiet`, with no note,
  as `process` does.
- Why: on the real 2026-W43 run (`quality`, 147 items) the input guards took 2,732 s and 3,897 s
  on two runs and dropped nothing; `process` kept 58 and picked 5. The model guards now check about
  5 items, about 100 s. See [cost and hardware](../overview/cost-and-hardware.md).
- Exception: with `models.rescoreWithWriter` on (off by default), `guardInput` runs every input
  guard on every item, as before, and `guardCandidates` does nothing. That option sends items to a
  writer model during classify, and a model that writes text must never read an item the model
  guards did not check. Why the classifier may read such an item:
  [safety](../architecture/safety.md#which-models-read-an-unchecked-item).
- A check runs only when its section and the check are on in config and a guard with that id was
  built. With nothing active, everything is kept.
- Each guard runs over the whole batch of items or drafts before the next guard starts, so only one
  guard model is loaded at a time. Calls are made one at a time on purpose.
- Mode `any` (default): the first flag drops the item or rejects the draft. Mode `all`: only
  subjects flagged by every active guard are dropped. The rule guard `ruleInjection` is the
  exception: it runs first and a hit always drops the item, in both modes. Then `clefPolicy` and
  `graniteRisk` run in the configured mode.
- The two `clef` checks flag when the probability of "yes" on any question is above
  `thresholds.guardFlag` (default 0.35). A value equal to the threshold does not flag.
- Guards fail closed. Granite must answer exactly yes or no; anything else flags the subject as
  "unparsable guard output". A digest item with no source item is flagged.
- A guard error fails the run at that step. It is never treated as a pass.
- A guard that is off or missing is never silent. It is listed as `disabledGuards` in
  `run.json` and named in the digest footer, and `digest doctor` warns about it.
- A slow guard is not silent: each model guard logs a `Progress` line every 25 items or minute
  with how many it has done, how many there are and the time left (see
  [observability](../operations/observability.md)). The model input guards log theirs in the
  `guardCandidates` step. `guardInput` ends with `Input guards done` (`kept`, `dropped`) and
  `guardCandidates` with `Candidate guards done` (`kept`, `dropped`, `checked`, `rounds`).
- Dropped items vanish from the week. `run.json` counts show how many passed (`afterGuardInput`)
  and how many items the model guards checked (`guardedCandidates`). Rejected drafts keep their
  check ids in `drafts.json`. Logs hold ids and check ids, never item or draft text.

## What you can configure

- `guards.input.enabled`, `guards.input.mode`, `guards.input.checks.ruleInjection`,
  `guards.input.checks.clefPolicy` and `guards.input.checks.graniteRisk`. See
  [guards](../configuration/guards.md).
- `guards.output.enabled`, `guards.output.mode`, `guards.output.checks.graniteGroundedness` and
  `guards.output.checks.clefRubric`.
- `thresholds.guardFlag`. See [thresholds](../configuration/thresholds.md).
- The guard models come from the profile (roles `guardPolicy` and `guardRisk`). Timeouts and
  thinking: `models.timeoutsMs` and `models.think`. See [models](../configuration/models.md).
- `models.rescoreWithWriter` moves the model input guards back to `guardInput`, on every item. See
  [models](../configuration/models.md#modelsrescorewithwriter).
- The link check and format check have no setting. All keys: [config keys](../reference/config-keys.md).
- Runbooks: [turn a guard on or off](../runbooks/configure/turn-a-guard-on-or-off.md),
  [change guard mode](../runbooks/configure/change-guard-mode.md) and
  [change thresholds](../runbooks/configure/change-thresholds.md).

## What can go wrong

- A guard rejects good drafts, so every draft is rejected. The week is then sent as the
  [fallback digest](digest.md#fallback-digest), which no model wrote (`fallback: true` in
  `run.json`). See [blocked run](../runbooks/debug/blocked-run.md). Read the draft before you
  switch a guard off.
- A good item never reaches the digest. See
  [missing or wrong item](../runbooks/debug/missing-or-wrong-item.md).
- A guard model call times out or the model is missing: the run is `failed` with step
  `guardCandidates` (`guardInput` when `models.rescoreWithWriter` is on) or `guardOutput`. See
  [failed run](../runbooks/debug/failed-run.md) and
  [slow model or out of memory](../runbooks/debug/slow-model-or-out-of-memory.md).
- Every item is dropped by the rule guard: the week is `quiet`, because process sees no items.
- The model guards flag picks until fewer than 3 eligible items are left: the week is `quiet`.

## Code and tests

- Folder: [src/guards/](../../src/guards/). Maintainer notes: [CLAUDE.md](../../src/guards/CLAUDE.md).
- Ports: `InputGuard` and `OutputGuard` in [Guard.ts](../../src/guards/Guard.ts). Adapters:
  [src/guards/adapters/](../../src/guards/adapters/) (the rule guard, the decision-model guards and
  Granite Guardian). The guard check ids live in `src/guards/guardVerdict.ts`.
- Tests sit next to the code. Granite replies recorded from the real model are replayed in a test.

## Related

- guardInput: before it [sources](sources.md), after it [classify](classify.md). guardCandidates:
  before it [process](process.md), after it [write](write.md).
- Output guards read what [write](write.md) and [checks](checks.md) passed, then [select](select.md).
- The model calls go through [models](models.md). Guard measures:
  [guard attack recall](../evaluation/metrics/guard-attack-recall.md) and
  [guard false blocks](../evaluation/metrics/guard-false-blocks.md).
