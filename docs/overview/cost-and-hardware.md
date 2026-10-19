# Cost and hardware

Part of [Overview](README.md).

The tool costs nothing to run, but the models are large. Pick a [profile](../configuration/profiles.md)
that fits the machine.

## Profiles at a glance

| Profile   | RAM                              | Disk for models | Run time per week              | Measured |
| --------- | -------------------------------- | --------------- | ------------------------------ | -------- |
| `light`   | 16 GB, Apple silicon only        | about 20 GB     | about 6 min (340 s on average) | yes      |
| `fast`    | not measured, Apple silicon only | about 33 GB     | not measured                   | no       |
| `quality` | 32 GB, Apple silicon only        | about 66 GB     | about 1 h                      | no       |

Other machines (not Apple silicon) run an untuned fallback set of about 45 GB of models, far more
than 16 GB of RAM. `digest doctor` says so, and `digest doctor --readiness` prints a verdict per
profile for the machine it runs on.

Measured numbers and how they were taken are on the [results page](../evaluation/results.md).
The `quality` figure is from one earlier run (131 items in about 59 minutes) and is not a
baseline.

## Software

| Needs          | Version                                             |
| -------------- | --------------------------------------------------- |
| Node.js        | 24 or newer (when you run from source)              |
| pnpm           | the version in `package.json` (`packageManager`)    |
| Ollama         | 0.40.0 or newer (0.35.1 for the non-Apple fallback) |
| Docker Compose | 2.24 or newer (when you use Docker)                 |

On a host Ollama set `OLLAMA_MAX_LOADED_MODELS=1` and restart it. Only one model is used at a
time, so RAM follows the largest single model.

## Network

Nothing else is called, so this is the whole allowlist:

- the feed hosts in the [default source list](../sources.md), or the ones you configure
- `api.github.com`, only when `GITHUB_TOKEN` is set
- your Ollama (`OLLAMA_URL`)
- the SMTP host and the Slack webhook you configure

## Disk

- Models: see the table above. They live in Ollama's store (or the `ollama-models` Docker volume).
- Runs: `data/runs/<week>/` is small. Folders older than `keepWeeks` (12) keep only `digest.md`.
  See [disk and pruning](../operations/disk-and-pruning.md).

## Related

- [Choose a profile and pull models](../runbooks/set-up/choose-profile-and-pull-models.md)
- [Model licences](../reference/model-licences.md)
- [Slow model or out of memory](../runbooks/debug/slow-model-or-out-of-memory.md)
