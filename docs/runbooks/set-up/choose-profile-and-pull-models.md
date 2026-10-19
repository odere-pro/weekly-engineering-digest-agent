# Choose a profile and pull models

Part of [Runbooks](../README.md) / Set up.

## Purpose

Pick the model profile that fits this machine, then pull exactly the Ollama models it needs.

## When to use

- During setup, after `digest init`, and whenever `digest doctor` says a model is `not installed`.
- To swap a writer model, use [Change models or writers](../configure/change-models-or-writers.md).
  To move to a newer model tag, use [Upgrade models](../maintain/upgrade-models.md).

## Prerequisites

- Ollama 0.40.0 or newer running (0.35.1 or newer for the non-Apple fallback set).
- Free disk for the models (the table below), on the disk that holds Ollama's store.
- A config file. If you have none, run `digest init` first.

## Steps

1. Ask the tool what this machine can run. It lists every profile with a verdict and prints the
   `ollama pull` lines that are missing. In Docker the prefix is
   `docker compose run --rm digest <command>`.

   ```bash
   pnpm digest doctor --readiness
   ```

2. Choose the profile. Only Apple silicon runs the tuned models. Anything else (including a Linux
   container) uses the fallback set, whatever `profile` says.

   | Profile   | Models to pull                                                                              | RAM                 | Disk   |
   | --------- | ------------------------------------------------------------------------------------------- | ------------------- | ------ |
   | `light`   | `strands-decider:2b-mlx-bf16`, `granite4.1-guardian:8b`, `gemma4:e4b-mlx`                   | 16 GB               | ~20 GB |
   | `fast`    | `strands-decider:2b-mlx-bf16`, `granite4.1-guardian:8b`, `nemotron-3.5-lightning:30b-mlx`   | not measured        | ~33 GB |
   | `quality` | `clef:latest`, `granite4.1-guardian:8b`, `gemma4:31b-mlx`, `nemotron-3.5-lightning:30b-mlx` | 32 GB               | ~66 GB |
   | fallback  | `clef:latest`, `granite4.1-guardian:8b`, `gemma4:31b`                                       | far more than 16 GB | ~45 GB |

   `light` is the only profile with a measured baseline, and the one `digest init` recommends. The
   schema default is `quality`. To change the profile, edit `profile` in `digest.config.json` (or
   run `digest init` again, which rewrites the whole file).

3. Pull each missing model. `doctor` prints these lines under `fix:`.

   ```bash
   ollama pull gemma4:e4b-mlx
   ```

4. Docker on Linux: skip step 3. The `model-pull` service pulls the fallback set into the
   `ollama-models` volume on `docker compose --profile linux up -d`. It reads `models.writers`
   from the config. To print the list it would pull:

   ```bash
   DIGEST_CONFIG=digest.config.json sh docker/pull-models.sh --list
   ```

   Docker on a Mac: run `ollama pull` on the host, not in a container.

5. Check the result.

   ```bash
   ollama list
   ```

## Verify

- `digest doctor` shows `✓ model <tag>: installed` for each tag. The classify, policy and judge
  tags read `installed (decision model)`.
- `digest doctor --readiness` shows `ready` for your profile.
- A guard whose checks are all switched off needs no model, so `doctor` does not ask for it.

## Roll back

Models are only files. Remove one you no longer want with `ollama rm <tag>`. To go back to a
different profile, set `profile` again. See [Prune disk](../maintain/prune-disk.md).

## Troubleshooting

| Symptom                                                       | Cause                                           | Fix                                                                                                        |
| ------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `model <tag>: not installed`                                  | Not pulled, or a different tag is installed     | `ollama pull <tag>`; compare with `ollama list`.                                                           |
| `installed, but it is not a decision model`                   | The tag lacks the `decision` capability         | Pull the exact tag in the table. Use Ollama 0.40.0 or newer.                                               |
| `Ollama X is older than 0.40.0, the minimum for this profile` | Ollama is too old                               | Update Ollama.                                                                                             |
| `profile light needs Apple silicon; ... falls back`           | Not Apple silicon, or a container without hints | Use a Mac, or accept the heavy fallback. Docker on a Mac: [install with Compose](install-with-compose.md). |
| `ollama pull` stops: no space left                            | Disk too small for the profile                  | Free disk, or pick a smaller profile.                                                                      |
| Slow or out of memory on a run                                | Profile too big for the RAM                     | [Slow model or out of memory](../debug/slow-model-or-out-of-memory.md).                                    |

## Related

- [Cost and hardware](../../overview/cost-and-hardware.md), [Profiles](../../configuration/profiles.md)
- [Models](../../configuration/models.md), [Model licences](../../reference/model-licences.md)
- [src/config/profiles.ts](../../../src/config/profiles.ts)
