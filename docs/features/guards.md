# Guards

Part of [Features](README.md).

## What it is for

Collected text and model drafts are untrusted. Guards are the model-based safety checks. Input
guards look at each collected item before any other model sees it. Output guards look at each
draft. They catch prompt injection, harmful content, claims the sources do not support, off-task
text and hype. Config can switch a guard off. The link check and format check are not guards: see
[checks](checks.md).

## Where it sits

It runs twice: guardInput right after collect, and guardOutput after write and before select. See
[data flow](../architecture/data-flow.md).

## What it does

- Four checks. Input: `clefPolicy` (is the item aimed at an AI system, or harmful?) and
  `graniteRisk` (Granite Guardian is asked about jailbreak, then harm). Output:
  `graniteGroundedness` (each digest item against its own source, then the headline and intro
  against the cited sources) and `clefRubric` (is the draft off-task, hype or harmful?).
- A check runs only when its section and the check are on in config and a guard with that id was
  built. With nothing active, everything is kept.
- Guards run one after another over all items or drafts, so only one guard model is loaded at a
  time. Calls are made one at a time on purpose.
- Mode `any` (default): the first flag drops the item or rejects the draft. Mode `all`: only
  subjects flagged by every active guard are dropped.
- The two `clef` checks flag when the probability of "yes" on any question is above
  `thresholds.guardFlag` (default 0.35). A value equal to the threshold does not flag.
- Guards fail closed. Granite must answer exactly yes or no; anything else flags the subject as
  "unparsable guard output". A digest item with no source item is flagged.
- A guard error fails the run at that step. It is never treated as a pass.
- A guard that is off or missing is never silent. It is listed as `disabledGuards` in `run.json`
  and named in the digest footer, and `digest doctor` warns about it.
- Dropped items vanish from the week. `run.json` counts show how many passed. Rejected drafts keep
  their check ids in `drafts.json`. Logs hold ids and check ids, never item or draft text.

## What you can configure

- `guards.input.enabled`, `guards.input.mode`, `guards.input.checks.clefPolicy` and
  `guards.input.checks.graniteRisk`. See [guards](../configuration/guards.md).
- `guards.output.enabled`, `guards.output.mode`, `guards.output.checks.graniteGroundedness` and
  `guards.output.checks.clefRubric`.
- `thresholds.guardFlag`. See [thresholds](../configuration/thresholds.md).
- The guard models come from the profile (roles `guardPolicy` and `guardRisk`). Timeouts and
  thinking: `models.timeoutsMs` and `models.think`. See [models](../configuration/models.md).
- The link check and format check have no setting. All keys: [config keys](../reference/config-keys.md).
- Runbooks: [turn a guard on or off](../runbooks/configure/turn-a-guard-on-or-off.md),
  [change guard mode](../runbooks/configure/change-guard-mode.md) and
  [change thresholds](../runbooks/configure/change-thresholds.md).

## What can go wrong

- A guard rejects good drafts, so every draft is rejected and the week is `blocked` (exit 2). See
  [blocked run](../runbooks/debug/blocked-run.md). Read the draft before you switch a guard off.
- A good item never reaches the digest. See
  [missing or wrong item](../runbooks/debug/missing-or-wrong-item.md).
- A guard model call times out or the model is missing: the run is `failed` with step `guardInput`
  or `guardOutput`. See [failed run](../runbooks/debug/failed-run.md) and
  [slow model or out of memory](../runbooks/debug/slow-model-or-out-of-memory.md).
- Every item is dropped by the input guards: the week is `quiet`, because process sees no items.

## Code and tests

- Folder: [src/guards/](../../src/guards/). Maintainer notes: [CLAUDE.md](../../src/guards/CLAUDE.md).
- Port: [Guard.ts](../../src/guards/Guard.ts). Adapters:
  [src/guards/adapters/](../../src/guards/adapters/) (decision-model guards and Granite Guardian).
- Tests sit next to the code. Granite replies recorded from the real model are replayed in a test.

## Related

- Before: [sources](sources.md). After the input guards: [classify](classify.md).
- Output guards read what [write](write.md) and [checks](checks.md) passed, then [select](select.md).
- The model calls go through [models](models.md). Guard measures:
  [guard attack recall](../evaluation/metrics/guard-attack-recall.md) and
  [guard false blocks](../evaluation/metrics/guard-false-blocks.md).
