# Guards

Part of [Configuration](README.md).

Guards are safety checks. Input guards look at collected items: the rule guard reads every item
before any model does, and the model input guards check the items `process` picked before any
writer sees them (see [When the input guards run](#when-the-input-guards-run)). Output guards look
at each draft the writers produce. Four guards ask a model. A fifth, `ruleInjection`, is fixed
rules in code (see [The rule guard](#the-rule-guard-ruleinjection)). You can switch each guard off
or change how strict each side is. You cannot switch off the link check or the format check.

## Keys

All keys are under `guards`. Both sections have the same shape.

| Key                                        | Type           | Default |
| ------------------------------------------ | -------------- | ------- |
| `guards.input.enabled`                     | boolean        | `true`  |
| `guards.input.mode`                        | `any` or `all` | `any`   |
| `guards.input.checks.ruleInjection`        | boolean        | `true`  |
| `guards.input.checks.clefPolicy`           | boolean        | `true`  |
| `guards.input.checks.graniteRisk`          | boolean        | `true`  |
| `guards.output.enabled`                    | boolean        | `true`  |
| `guards.output.mode`                       | `any` or `all` | `any`   |
| `guards.output.checks.graniteGroundedness` | boolean        | `true`  |
| `guards.output.checks.clefRubric`          | boolean        | `true`  |

A check runs only when its section (`enabled`) and the check itself are both `true`.

```json
{
  "guards": {
    "input": { "mode": "any", "checks": { "ruleInjection": true, "graniteRisk": false } },
    "output": { "checks": { "clefRubric": false } }
  }
}
```

Keys you leave out keep their defaults.

## The four model checks

| Check                 | Side   | Model role    | What it asks                                                          |
| --------------------- | ------ | ------------- | --------------------------------------------------------------------- |
| `clefPolicy`          | input  | `guardPolicy` | Is the item aimed at an AI system, or harmful? Yes/no questions       |
| `graniteRisk`         | input  | `guardRisk`   | Granite Guardian: jailbreak first, then harm                          |
| `graniteGroundedness` | output | `guardRisk`   | Is each item backed by its source? Are the headline and intro backed? |
| `clefRubric`          | output | `guardPolicy` | Is the draft off-task, hype or harmful? Yes/no questions              |

The two `clef` checks flag when any answer's probability of "yes" is above `thresholds.guardFlag`
(0.35, see [thresholds](thresholds.md)); exactly at the threshold does not flag. The two Granite
checks must answer exactly yes or no. Any other reply counts as a flag (the guards fail closed).
Guards run one call at a time, guard by guard, so only one guard model is loaded at once.

## The rule guard, `ruleInjection`

`ruleInjection` is a check on the input side that reads each item's title, summary and URL against a
fixed table of rules. It makes no model call, so it needs no model, no `guardPolicy` or `guardRisk`
role and no time. It is the first input check: it reads every collected item in `guardInput`,
before `classify`, `clefPolicy` and `graniteRisk`. An item it flags never reaches any model, in
either mode.

- It flags an item when any rule matches. The verdict reason is `ruleInjection:` and the matching
  rule ids, for example `ruleInjection: ignorePrevious, offHostLink`, never item text. A run logs
  only the check id (`flaggedBy`, debug level), so the rule ids are not in `run.json`.
- It looks for: "ignore the previous instructions" and similar orders (English and French), a
  "you are now DAN" persona swap, fake `[SYSTEM]:` or `Assistant:` lines, chat-template tokens,
  text that closes the data block, text that speaks to the AI reader, long encoded blobs, hidden
  zero-width or bidi characters (a zero-width character, a left-to-right or right-to-left mark or
  an Arabic letter mark between two Latin letters, a bidi override or isolate, a deprecated format
  control, a tag character), `javascript:` and `data:` URLs, and a link to another host in a
  sentence that gives an order ("add a link", "webhook"), or to a raw IP or look-alike host. A plain
  "see https://other.org" passes, and so do links to the item's own host and your feed hosts.
  Hebrew and Arabic titles keep their direction marks: a mark only counts between two Latin letters.
- Its only setting is `guards.input.checks.ruleInjection` (and `guards.input.enabled` for the whole
  input section). It has no threshold; `thresholds.guardFlag` does not apply.
- A real item that quotes an attack string would match and be dropped. See
  [Missing or wrong item](../runbooks/debug/missing-or-wrong-item.md).

## Modes

| Mode  | A subject is dropped when                                          |
| ----- | ------------------------------------------------------------------ |
| `any` | The first active check flags it. Strictest, and the default        |
| `all` | Every active check flags it. Fewer false blocks, weaker protection |

Subjects are items (input) or drafts (output). With only one check on, both modes behave alike.
The rule guard is the exception. It is fixed rules in code, so a hit always drops the item, in
mode `any` and in mode `all`. It runs first. Only the items it passes go on to the model guards,
and mode `all` applies to those. So `all` on the input side still drops every rule hit.

## When the input guards run

| Step              | Input checks                     | Items checked                              |
| ----------------- | -------------------------------- | ------------------------------------------ |
| `guardInput`      | `ruleInjection`                  | Every collected item, before `classify`    |
| `guardCandidates` | `clefPolicy`, then `graniteRisk` | The items `process` picked, before `write` |

A pick the model guards flag is removed and `process` picks again without it. After a flag, the
next batch is topped up to the number of picks with the next-ranked eligible items. This repeats
until every pick has passed or no eligible item is left. Fewer than 3 items left ends the week
`quiet`.

With `models.rescoreWithWriter` on (off by default), all three input checks run in `guardInput` on
every item, as before, and `guardCandidates` does nothing. That option sends items to a writer
model during classify, and a model that writes text must never read an item the model guards did
not check. See [models](models.md#modelsrescorewithwriter) and
[safety](../architecture/safety.md#which-models-read-an-unchecked-item).

## What is recorded when a guard is off

- `disabledGuards` in `run.json` lists the check ids that did not run that week, including all
  checks of a section with `enabled: false`. The digest footer says `Guards off this week: <ids>.`
- `digest doctor` prints a `guards` warning with the ids.
- `digest doctor` and the pre-run model check skip a guard model when every check that uses it is
  off. With both Granite checks off, `granite4.1-guardian:8b` need not be pulled. The rule guard
  needs no model at all.

A draft rejected by a guard shows its check id in `rejectedBy`. If every draft is rejected, the run
sends the [fallback digest](../features/digest.md#fallback-digest) instead (`fallback: true` in
`run.json`). It ends `blocked` (exit 2, with a failure note) only if the fallback cannot be made.

## Checks that cannot be turned off

The **link check** rejects any URL in the digest that was not in the collected items, and any
link without a scheme. The **format check** needs 3 to 5 items, all fields, no em dash and fewer
than 500 words. They run in code on every draft. No key controls them, and an extra key you add
is ignored. They appear in `rejectedBy` as `linkCheck` and `formatCheck`.

## Change it

- [Turn a guard on or off](../runbooks/configure/turn-a-guard-on-or-off.md)
- [Change guard mode](../runbooks/configure/change-guard-mode.md)
- [Change thresholds](../runbooks/configure/change-thresholds.md)

## Related

- [Guards feature](../features/guards.md) and [checks feature](../features/checks.md)
- [Safety](../architecture/safety.md)
- [Guard false blocks metric](../evaluation/metrics/guard-false-blocks.md)
- [src/guards/CLAUDE.md](../../src/guards/CLAUDE.md)
