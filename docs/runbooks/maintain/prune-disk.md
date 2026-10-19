# Prune disk

Part of [Runbooks](../README.md) / Maintain.

## Purpose

Free disk by trimming old run folders, debug output and unused models, without losing the
history the next run needs.

## When to use

- `digest doctor --readiness` shows little free disk, or a run fails to save its record.
- You changed profile and the old models are dead weight.
- For what pruning does on its own and why, read [Disk and pruning](../../operations/disk-and-pruning.md).

## Prerequisites

- The settings that control pruning:

| Key           | Default | Meaning                                                                               |
| ------------- | ------- | ------------------------------------------------------------------------------------- |
| `keepWeeks`   | 12      | Run folders older than this many weeks keep only `digest.md`. At least 1.             |
| `dedupeWeeks` | 4       | Weeks of sent links removed from new digests (0 to 12). `keepWeeks` may not be lower. |

- Pruning runs by itself at the end of every run and is best effort. It deletes everything in an
  old week folder except `digest.md`, including `run.json`. After that `history`, `show` and
  `preview` no longer see the week, and its links no longer count for dedupe.
- Do not delete `data/runs/<week>` for the last `dedupeWeeks` weeks: items would repeat. Do not
  delete `data/digest.lock` while a run is live, nor `digest.config.json` or `.env`.

## Steps

1. Measure. `doctor --readiness` prints free disk for the data folder and the Ollama models folder.

   ```bash
   pnpm digest doctor --readiness
   ```

   ```bash
   du -sh data/runs data/digests dist ~/.ollama/models
   ```

2. Trim run history with config. Lower `keepWeeks` in `digest.config.json` (not below
   `dedupeWeeks`). It takes effect at the end of the next run. Restart `serve` so it reads it.
3. Remove generated output you do not need. All of it can be rebuilt.
   - `dist/fetch/` and `dist/preview/` (output of `digest fetch` and `digest preview`).
   - Old `dist/digests/<week>.md` and `.html`, if you do not need the archive.
   - `data/feedback/<week>.json` once merged into the eval labels.
4. Remove one old week by hand if you cannot wait for the next run, for example
   `rm -r data/runs/2026-W20`. Keep `digest.md` if you want the archive.
5. Remove models you no longer use. `ollama list` shows sizes. Keep every tag of the profile you
   run (`doctor` tells you which).

   ```bash
   ollama rm <tag>
   ```

   Docker on Linux: the models sit in the `ollama-models` volume. Remove one from inside the
   `ollama` service. To remove all of them, add `--volumes` to `down`; the next `up` downloads
   them again.

   ```bash
   docker compose --profile linux exec ollama ollama rm <tag>
   ```

## Verify

- `du -sh` shows less, and `doctor --readiness` shows more free disk.
- `pnpm digest history -n 14` still lists the weeks you kept.
- `pnpm digest doctor` is green: no model you need is missing.
- After the next run, the log line `Pruned old runs` lists the folders it emptied.

## Roll back

Deleted files cannot be restored; use a backup. A removed model comes back with
`ollama pull <tag>`. A lowered `keepWeeks` can be raised again, but it does not bring old folders
back.

## Troubleshooting

| Symptom                                                                              | Cause                                          | Fix                                                       |
| ------------------------------------------------------------------------------------ | ---------------------------------------------- | --------------------------------------------------------- |
| `keepWeeks must be at least dedupeWeeks: pruned weeks drop out of cross-week dedupe` | `keepWeeks` is below `dedupeWeeks`             | Raise `keepWeeks` or lower `dedupeWeeks`.                 |
| Old items show up in a new digest                                                    | You deleted a recent week's `run.json`         | Keep the last `dedupeWeeks` weeks. Nothing restores them. |
| Log line `Could not prune old runs`                                                  | The data folder is not writable                | Fix permissions: `doctor` shows the `data dir` line.      |
| `Could not save the run record (...)`                                                | The disk is full or the folder is not writable | Free disk, then [run again](../run/run-now.md).           |
| `model <tag>: not installed` after cleanup                                           | You removed a model the profile needs          | `ollama pull <tag>`.                                      |

## Related

- [Disk and pruning](../../operations/disk-and-pruning.md), [Data layout](../../architecture/data-layout.md)
- [Choose a profile and pull models](../set-up/choose-profile-and-pull-models.md)
- [src/store/CLAUDE.md](../../../src/store/CLAUDE.md)
