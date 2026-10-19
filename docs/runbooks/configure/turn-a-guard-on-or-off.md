# Turn a guard on or off

Part of [Runbooks](../README.md) / [Configure](README.md).

## Purpose

Switch one model-based safety check on or off, or a whole group of them. Every switch is
recorded, so a digest never goes out with a hidden gap.

## When to use

- A guard blocks good drafts or items week after week, and you have read what it blocked.
- You must free time or memory and accept a weaker check. The Granite checks are the slow ones.
- You want a guard back on after a test.
- To make a guard less eager instead of off, use [Change thresholds](change-thresholds.md)
  (`thresholds.guardFlag`). To change how flags combine, use [Change guard mode](change-guard-mode.md).

## Prerequisites

- You have read why the run was blocked ([Blocked run](../debug/blocked-run.md)). Guards are the
  defence against hostile text in feeds, so switching one off is a risk decision.
- Write access to `digest.config.json`.

## Steps

1. Pick the switch. All default to `true`.

   | Key                                        | Check                 | What it looks at                             |
   | ------------------------------------------ | --------------------- | -------------------------------------------- |
   | `guards.input.enabled`                     | both input checks     | Each collected item, before other models     |
   | `guards.input.checks.clefPolicy`           | `clefPolicy`          | Is the item aimed at an AI system or harmful |
   | `guards.input.checks.graniteRisk`          | `graniteRisk`         | Jailbreak and harm, by Granite Guardian      |
   | `guards.output.enabled`                    | both output checks    | Each draft                                   |
   | `guards.output.checks.graniteGroundedness` | `graniteGroundedness` | Claims not backed by the cited sources       |
   | `guards.output.checks.clefRubric`          | `clefRubric`          | Off-task, hype or harmful drafts             |

   The link check and the format check have no switch. They always run.

2. Edit `digest.config.json`. This turns off one output check and leaves the rest on:

   ```json
   {
     "guards": {
       "output": { "checks": { "graniteGroundedness": false } }
     }
   }
   ```

   To turn a section off, set `"enabled": false` in `guards.input` or `guards.output`. To turn a
   guard back on, set the key to `true` or delete it.

3. Apply the change. `digest serve` reads the config once, at start. In Docker:
   `docker compose restart digest`. A manual `pnpm digest run` and a host timer read the file
   again each time. In Docker, other commands are `docker compose run --rm digest <command>`.
4. Run the check.

   ```bash
   pnpm digest doctor
   ```

   ```text
   ! guards: off: graniteGroundedness; the digest footer will say so
       fix: turn them back on under "guards" in digest.config.json
   ```

## Verify

- `pnpm digest doctor` names exactly the checks you turned off (a `!` is expected, exit code 0).
- After the next run, the digest ends with `Guards off this week: graniteGroundedness.` and
  `pnpm digest show <week>` prints `Guards off: graniteGroundedness`. The same ids are in
  `disabledGuards` of `run.json`.
- If both Granite checks are off, doctor no longer asks for `granite4.1-guardian:8b`. Turning
  off both Clef checks frees no model in the built-in profiles: the classify role uses the same tag.

## Roll back

Set the key back to `true` (or delete it) and restart as in step 3. If Granite was off for a
while, run `pnpm digest doctor` and pull what it lists, for example `ollama pull granite4.1-guardian:8b`.

## Troubleshooting

| Symptom                                                             | Cause                                                                         | Fix                                                                     |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Doctor still says `guards: all guards on`                           | Key misspelled, such as `enable` (unknown keys are dropped without a message) | Use `enabled` and the exact check ids                                   |
| `Ollama is missing models for profile ...` after turning a guard on | The guard's model was never pulled                                            | `ollama pull <tag>` as doctor prints                                    |
| Runs are still `blocked`                                            | The link check or the format check rejected it                                | They cannot be switched off; see [Blocked run](../debug/blocked-run.md) |
| The footer was not in the digest                                    | The digest was written before the change                                      | The next run carries it                                                 |

## Related

- [Guards](../../configuration/guards.md), [Config keys](../../reference/config-keys.md)
- [Change guard mode](change-guard-mode.md), [Change thresholds](change-thresholds.md)
- [src/guards/CLAUDE.md](../../../src/guards/CLAUDE.md)
