# Set seed and temperature

Part of [Runbooks](../README.md) / [Configure](README.md).

## Purpose

Control how repeatable or varied the model output is. The seed makes a rerun of a week follow
the same path; the temperature sets how adventurous the writers are.

## When to use

- You want the same week to give the same digest when you run it again (keep the defaults).
- The writing feels flat or repetitive: raise the writer temperature a little.
- You want a different draft of the same week: change the seed for one run.
- To change which models run, use [Change models or writers](change-models-or-writers.md).

## Prerequisites

- `pnpm digest doctor` shows no `✗` line.
- Know what counts. Only chat (`generate`) calls carry a seed and a temperature. In a real run
  those are the writers (role `write`) and the Granite guard (role `guardRisk`). The decision
  calls (`classify`, `guardPolicy`, `judge`) send neither, so those keys change nothing there.
  The Granite guard also fixes its own temperature at 0. In practice `models.temperature.write`
  is the one temperature that matters.

## Steps

1. Know the keys and defaults.

   | Key                         | Range                   | Default                                               |
   | --------------------------- | ----------------------- | ----------------------------------------------------- |
   | `models.seed`               | whole number, 0 or more | 42                                                    |
   | `models.temperature.write`  | 0 to 2                  | 0.2                                                   |
   | `models.temperature.<role>` | 0 to 2                  | 0 for `classify`, `guardPolicy`, `guardRisk`, `judge` |

   Roles are `classify`, `guardPolicy`, `guardRisk`, `write` and `judge`. Another name is
   rejected (`Unrecognized key`).

2. Edit `digest.config.json`.

   ```json
   {
     "models": {
       "seed": 7,
       "temperature": { "write": 0.4 }
     }
   }
   ```

3. Apply the change. `digest serve` reads the config once, at start. In Docker:
   `docker compose restart digest`. A manual `pnpm digest run` and a host timer read the file
   again each time. In Docker, other commands are `docker compose run --rm digest <command>`.
4. For one run only, leave the config alone and pass the seed.

   ```bash
   pnpm digest run --dry-run --seed 7
   ```

## Verify

- The run record keeps what the run used. Read it back after a run:

  ```bash
  pnpm digest show 2026-W42 --part run
  ```

  ```text
  "sampling": {
    "seed": 7,
    "temperatureByRole": { "classify": 0, "guardPolicy": 0, "guardRisk": 0, "write": 0.4, "judge": 0 }
  }
  ```

  The map lists every role, including roles whose calls take no temperature.

- A same-seed rerun is expected to repeat, not guaranteed. Models and Ollama versions can still
  differ. The eval set measures this as stability ([Stability](../../evaluation/sets/stability.md)).

## Roll back

Delete `seed` and `temperature` from `models` (the defaults return) and restart as in step 3.

## Troubleshooting

| Symptom                                                            | Cause                                    | Fix                                 |
| ------------------------------------------------------------------ | ---------------------------------------- | ----------------------------------- |
| `Too small: expected number to be >=0` at `models.seed`            | A negative seed                          | Use 0 or more                       |
| `Too big: expected number to be <=2` at `models.temperature.write` | Temperature above 2                      | Use 0 to 2                          |
| `Unrecognized key: "writer"` at `models.temperature`               | The role is called `write`               | Use a role name from step 1         |
| `Invalid --seed "x". Use a whole number of 0 or more.`             | A bad `--seed` value                     | Pass an integer                     |
| Same seed, different text                                          | Not guaranteed across models or versions | Compare `modelsByRole` of both runs |
| Changing `classify` temperature does nothing                       | Decision calls take no temperature       | Expected                            |

## Related

- [Models](../../configuration/models.md), [Config keys](../../reference/config-keys.md)
- [Run record](../../reference/run-record.md), [Re-run a week](../recover/re-run-a-week.md)
- [src/models/CLAUDE.md](../../../src/models/CLAUDE.md)
