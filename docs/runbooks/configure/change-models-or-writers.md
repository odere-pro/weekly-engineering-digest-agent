# Change models or writers

Part of [Runbooks](../README.md) / [Configure](README.md).

## Purpose

Change which Ollama models write the digest: pick another profile, or replace the writer panel
with your own list of model tags.

## When to use

- The runs are too slow or run out of memory: move to a smaller profile or one writer.
- You want a different writer model, or a panel of several writers.
- To add a judge or change panel size on purpose, see [Set the judge](set-the-judge.md).
- To pull the models of a profile for the first time, see
  [Choose a profile and pull models](../set-up/choose-profile-and-pull-models.md).

## Prerequisites

- Ollama runs and `pnpm digest doctor` shows no `✗` line.
- The new tag is installed: `ollama pull <tag>`, then `ollama list` shows it.
- Config can change only the writers. The classify, guard and judge models come from the profile
  (`profile`: `quality`, `fast` or `light`), not from separate keys.

## Steps

1. Choose how to change.

   | Goal                          | Edit                                                                        |
   | ----------------------------- | --------------------------------------------------------------------------- |
   | Other model set               | `profile` to `quality`, `fast` or `light`                                   |
   | Your own writer or panel      | `models.writers`, a list of Ollama tags that replaces the profile's writers |
   | Back to the profile's writers | Delete `models.writers`                                                     |

   Rules for `models.writers`: at least one tag, no duplicates (`writers must be unique:
outcomes and scores are keyed by tag`). One tag means no judge and no select step. Two or
   more tags add a judge and a select step.

2. Pull what you need.

   ```bash
   ollama pull gemma4:31b-mlx
   ```

3. Edit `digest.config.json`. This gives the `light` profile one larger writer:

   ```json
   {
     "profile": "light",
     "models": {
       "writers": ["gemma4:31b-mlx"]
     }
   }
   ```

4. Apply the change. `digest serve` reads the config once, at start. In Docker:
   `docker compose restart digest`. A manual `pnpm digest run` and a host timer read the file
   again each time. In Docker, other commands are `docker compose run --rm digest <command>`.
5. Run the check.

   ```bash
   pnpm digest doctor
   ```

## Verify

- Doctor prints one line per model in use:

  ```text
  ✓ model gemma4:31b-mlx: installed
  ✓ model strands-decider:2b-mlx-bf16: installed (decision model)
  ```

- Run `pnpm digest run --dry-run` ([Dry run](../run/dry-run.md)). Then
  `pnpm digest show <week> --part run` lists your tags under `modelsByRole.write`, and `winner`
  is one of them.
- Check time and quality against an earlier week with `pnpm digest history`. Only `light` has
  eval results ([Status and limits](../../overview/status-and-limits.md)); other panels are
  untested here.

## Roll back

Delete `models.writers` (and set `profile` back) and restart as in step 4. The pulled models can
stay in Ollama.

## Troubleshooting

| Symptom                                                             | Cause                                   | Fix                                                                    |
| ------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------- |
| `Ollama is missing models for profile "light": <tag>`               | The tag is not installed                | `ollama pull <tag>`                                                    |
| `✗ model <tag>: not installed`                                      | The same, seen by doctor                | Run the `fix:` line                                                    |
| `writers must be unique: outcomes and scores are keyed by tag`      | The same tag is listed twice            | Remove the duplicate                                                   |
| `Too small: expected array to have >=1 items` at `models.writers`   | An empty list                           | Delete the key to use the profile's writers                            |
| `Every writer failed: <tag>; drafts.json has the reasons`           | The model cannot produce a valid draft  | Read `pnpm digest show <week> --part drafts`; try another tag          |
| `Ollama generate call to <tag> (role write) timed out after ... ms` | A large model needs more time           | See [Change timeouts and retries](change-timeouts-and-retries.md)      |
| Out of memory, very slow runs                                       | The model is too large for this machine | [Slow model or out of memory](../debug/slow-model-or-out-of-memory.md) |

## Related

- [Models](../../configuration/models.md), [Profiles](../../configuration/profiles.md)
- [Config keys](../../reference/config-keys.md), [Model licences](../../reference/model-licences.md)
- [src/config/profiles.ts](../../../src/config/profiles.ts), [src/models/CLAUDE.md](../../../src/models/CLAUDE.md)
