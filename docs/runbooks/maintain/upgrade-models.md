# Upgrade models

Part of [Runbooks](../README.md) / Maintain.

## Purpose

Move to a newer model, or a newer build of the same tag, without breaking runs. You end with the
new model pulled, checked, compared with the old results and used by the scheduler.

## When to use

- A publisher releases a new writer, or re-pushes a tag you use.
- You upgrade Ollama itself.
- To pick a profile or pull a missing model on a new machine, use
  [Choose a profile and pull models](../set-up/choose-profile-and-pull-models.md).

## Prerequisites

- Know what you may change without code. Only the **writers** are set in config.

| You want to change                        | Where                                                                                                       |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| The writer model(s)                       | `models.writers` in `digest.config.json` (list of unique tags). More than one adds a judge (`clef:latest`). |
| The profile (`quality`, `fast`, `light`)  | `profile` in `digest.config.json`                                                                           |
| Classify, guard policy, guard risk, judge | Code only: `MODEL_TAGS` and `PROFILES` in `src/config/profiles.ts` (a maintainer change on `main`)          |
| Models pulled by Docker on Linux          | `docker/pull-models.sh`, which must match `NON_MAC_FALLBACK` in `profiles.ts` (`docker/validate.sh`)        |

- Read the licence of the new tag: `ollama show --license <tag>`, and
  [Model licences](../../reference/model-licences.md). Keep the exact Nemotron tag.
- The thresholds were tuned on `light` only, so a new classifier can shift the scores.
- Ollama 0.40.0 or newer (0.35.1 for the fallback set). Models are checked by `digest doctor`.

## Steps

1. Note what you have now. A tag that keeps its name changes under you when pulled again.

   ```bash
   ollama list
   ```

   To keep a writer you can return to, copy it first: `ollama cp <tag> <backup-name>`.

2. Pull the new tag. On Docker for Linux, run the pull service with `REFRESH_MODELS=1`:
   `REFRESH_MODELS=1 docker compose --profile linux run --rm model-pull`.

   ```bash
   ollama pull <new-tag>
   ```

3. Point the config at it (writers only), for example in `digest.config.json`:

   ```jsonc
   { "models": { "writers": ["<new-tag>"] } }
   ```

   For a classify, guard or judge tag, a maintainer edits `src/config/profiles.ts`, keeps
   `docker/pull-models.sh` in step, and runs `pnpm check` and `docker/validate.sh`.

4. Check the install.

   ```bash
   pnpm digest doctor
   ```

5. Try it without sending, then compare the digest with an earlier one.

   ```bash
   pnpm digest run --dry-run --out ./try
   ```

6. Measure it: [Run evals](../run/run-evals.md), then compare with the newest scorecard
   (`evals/scorecards/2026-10-18-light.json`) and [re-baseline](re-baseline-evals.md).
7. Restart `digest serve` so it reads the new config (`docker compose restart digest`).

## Verify

- `doctor` shows `✓ model <new-tag>: installed` and no `✗`.
- The dry run exits 0. The scorecard passes the hard gates you passed before.
- `pnpm digest history -n 1` after the next real run names the new tag as `Winner`.

## Roll back

Set `models.writers` (or `profile`) back and restart `serve`. If the tag was re-pushed and you made
a copy in step 1, point `models.writers` at the copy. Without a copy, the old build cannot be pulled
back from a moving tag. Remove the model you no longer use: [Prune disk](prune-disk.md).

## Troubleshooting

| Symptom                                                        | Cause                                          | Fix                                                                             |
| -------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------- |
| `model <tag>: not installed`                                   | Typo, or the pull failed                       | Compare with `ollama list`; pull again.                                         |
| `installed, but it is not a decision model`                    | A classify or judge tag without the capability | Use the tag in `profiles.ts`; update Ollama.                                    |
| `writers must be unique: outcomes and scores are keyed by tag` | Duplicate tag in `models.writers`              | Remove the duplicate.                                                           |
| Quality dropped or items changed a lot                         | New model, old thresholds                      | Compare scorecards; see [Change thresholds](../configure/change-thresholds.md). |
| A run times out                                                | The new model is slower                        | [Change timeouts](../configure/change-timeouts-and-retries.md).                 |

## Related

- [Change models or writers](../configure/change-models-or-writers.md), [Models](../../configuration/models.md)
- [Profiles](../../configuration/profiles.md), [Model licences](../../reference/model-licences.md)
- [src/config/CLAUDE.md](../../../src/config/CLAUDE.md)
