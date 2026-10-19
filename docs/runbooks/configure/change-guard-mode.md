# Change guard mode

Part of [Runbooks](../README.md) / [Configure](README.md).

## Purpose

Decide how several guards combine: block on the first flag (`any`, the default) or only when
every active guard flags the same item or draft (`all`).

## When to use

- Good items or drafts are blocked and you have read them. `all` blocks less.
- You moved back to the stricter `any` after a trial.
- To switch a guard off, use [Turn a guard on or off](turn-a-guard-on-or-off.md). To make one
  guard less sensitive, use [Change thresholds](change-thresholds.md).

## Prerequisites

- You know that `all` protects less: a hostile item or a false claim that only one guard catches
  gets through. Read [Blocked run](../debug/blocked-run.md) first.
- Write access to `digest.config.json`.

## Steps

1. Pick the mode for each section. Input and output are set apart.

   | Key                  | `any` (default)                                    | `all`                                                 |
   | -------------------- | -------------------------------------------------- | ----------------------------------------------------- |
   | `guards.input.mode`  | An item is dropped when any input guard flags it   | Dropped only when every active input guard flags it   |
   | `guards.output.mode` | A draft is rejected when any output guard flags it | Rejected only when every active output guard flags it |

   With one active check in a section the two modes act the same. In `all`, an item goes to the
   next guard only if the previous one flagged it, so the later (often slower) guard sees fewer
   items. The order is `ruleInjection`, `clefPolicy`, then `graniteRisk` for input, and
   `graniteGroundedness` then `clefRubric` for output. The rule guard runs first, so in `all` an
   input item is dropped only if `ruleInjection` flags it too. It flags rarely, so `all` on the
   input side drops very little unless you also turn `ruleInjection` off (see
   [Turn a guard on or off](turn-a-guard-on-or-off.md)).

2. Edit `digest.config.json`. This loosens output only:

   ```json
   {
     "guards": {
       "input": { "mode": "any" },
       "output": { "mode": "all" }
     }
   }
   ```

3. Apply the change. `digest serve` reads the config once, at start. In Docker:
   `docker compose restart digest`. A manual `pnpm digest run` and a host timer read the file
   again each time. In Docker, other commands are `docker compose run --rm digest <command>`.
4. Check that the file loads.

   ```bash
   pnpm digest doctor
   ```

## Verify

- Doctor shows no `✗ config` line. A wrong value gives `Invalid option: expected one of "any"|"all"`.
  Doctor does not print the mode, so open the file and read it back.
- After the next run, compare with an earlier week: `pnpm digest show <week>` lists fewer
  `Rejected:` lines, and `Items:` shows more left "after guards". Judge the winning digest by
  eye. Weaker guards are only safe if you keep reading what gets through.

## Roll back

Set the mode back to `"any"` (or delete the key) and restart as in step 3.

## Troubleshooting

| Symptom                                        | Cause                                                                        | Fix                                                              |
| ---------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `Invalid option: expected one of "any"\|"all"` | A typo, or a capital letter                                                  | Use lowercase `any` or `all`                                     |
| Still no model-written digest in `all` mode    | Every active guard flagged it, or the link check or format check rejected it | Read `pnpm digest show <week> --part drafts`                     |
| No difference after the change                 | Only one check is active in that section, or `serve` was not restarted       | See [Turn a guard on or off](turn-a-guard-on-or-off.md); restart |
| Mode seems ignored                             | The key sits in the wrong section                                            | Use `guards.input.mode` or `guards.output.mode`                  |

## Related

- [Guards](../../configuration/guards.md), [Config keys](../../reference/config-keys.md)
- [Blocked run](../debug/blocked-run.md)
- [src/guards/CLAUDE.md](../../../src/guards/CLAUDE.md)
