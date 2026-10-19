# Guards

Part of [Configuration](README.md).

Guards are model-based safety checks. Input guards look at each collected item before any other
model sees it. Output guards look at each draft the writers produce. You can switch each guard
off or change how strict the pair is. You cannot switch off the link check or the format check.

## Keys

All keys are under `guards`. Both sections have the same shape.

| Key                                        | Type           | Default |
| ------------------------------------------ | -------------- | ------- |
| `guards.input.enabled`                     | boolean        | `true`  |
| `guards.input.mode`                        | `any` or `all` | `any`   |
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
    "input": {
      "enabled": true,
      "mode": "any",
      "checks": { "clefPolicy": true, "graniteRisk": true }
    },
    "output": {
      "enabled": true,
      "mode": "any",
      "checks": { "graniteGroundedness": true, "clefRubric": false }
    }
  }
}
```

## The four checks

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

## Modes

| Mode  | A subject is dropped when                                          |
| ----- | ------------------------------------------------------------------ |
| `any` | The first active check flags it. Strictest, and the default        |
| `all` | Every active check flags it. Fewer false blocks, weaker protection |

Subjects are items (input) or drafts (output). With only one check on, both modes behave alike.

## What is recorded when a guard is off

- `disabledGuards` in `run.json` lists the check ids that did not run that week, including all
  checks of a section with `enabled: false`.
- The digest footer says `Guards off this week: <ids>.`
- `digest doctor` prints a `guards` warning with the ids.
- `digest doctor` and the pre-run model check skip a guard model when every check that uses it is off.
  For example, with both Granite checks off, `granite4.1-guardian:8b` need not be pulled.

A draft rejected by a guard shows its check id in `rejectedBy`. If every draft is rejected, the
run ends `blocked` (exit 2) and sends a failure note.

## Checks that cannot be turned off

The **link check** rejects any URL in the digest that was not in the collected items, and any
link without a scheme. The **format check** needs 3 to 5 items, all fields, no em dash and fewer
than 500 words. They run in code on every draft. No key controls them, and an extra key you add
is ignored. They appear in `rejectedBy` as `linkCheck` and `formatCheck`.

## Change it

- [Turn a guard on or off](../runbooks/configure/turn-a-guard-on-or-off.md)
- [Change guard mode](../runbooks/configure/change-guard-mode.md)
- [Change thresholds](../runbooks/configure/change-thresholds.md)
- [Blocked run](../runbooks/debug/blocked-run.md)

## Related

- [Guards feature](../features/guards.md) and [checks feature](../features/checks.md)
- [Safety](../architecture/safety.md)
- [Guard false blocks metric](../evaluation/metrics/guard-false-blocks.md)
- [src/guards/CLAUDE.md](../../src/guards/CLAUDE.md)
