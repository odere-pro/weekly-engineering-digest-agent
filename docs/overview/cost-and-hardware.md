# Cost and hardware

Part of [Overview](README.md).

The tool costs nothing to run, but the models are large. Pick a [profile](../configuration/profiles.md)
that fits the machine.

## Profiles at a glance

| Profile   | RAM                                                       | Disk for models | Run time per week                                          | Measured |
| --------- | --------------------------------------------------------- | --------------- | ---------------------------------------------------------- | -------- |
| `light`   | 16 GB, Apple silicon only                                 | about 20 GB     | about 6 min (340 s on average)                             | yes      |
| `fast`    | not measured, Apple silicon only                          | about 33 GB     | not measured                                               | no       |
| `quality` | 32 GB is tight (it swapped), 48 GB or more is an estimate | about 66 GB     | not measured end to end; the input guard alone took 65 min | partly   |

Other machines (not Apple silicon) run an untuned fallback set of about 45 GB of models, far more
than 16 GB of RAM. `digest doctor` says so, and `digest doctor --readiness` prints a verdict per
profile for the machine it runs on.

Measured numbers and how they were taken are on the [results page](../evaluation/results.md).
`light` is a baseline. `quality` is not: see the next section.

## `quality` on 32 GB: measured 2026-10-19

One `pnpm digest run --dry-run` of week 2026-W43 on `quality`, read from the run log
(`dist/logs/2026-10-19/digest.log` and `2026-10-20/`, the day files of one run, which was still
going when these numbers were taken).

- Machine: Apple M1 Pro, 32 GB of RAM, 8 of 9 GB of swap in use while it ran (reported by the
  maintainer, not in the log). `clef:latest` held 18 to 26 GB resident with a 16k context.
- Input: 147 collected items, one `guardPolicy` decision (clef) and two `guardRisk` calls (Granite:
  jailbreak, then harm) per item. All 147 were kept, none dropped.
- The first 10 or so `guardPolicy` calls ran while an evaluation was running on the same GPU and
  took 45 to 53 s each. That evaluation was stopped; the rest of the step ran alone.

| Step / role                          | Model                    | Calls | Time               | Median call | 90th percentile | Slowest |
| ------------------------------------ | ------------------------ | ----- | ------------------ | ----------- | --------------- | ------- |
| `collect`                            | none                     | 0     | 2 s                |             |                 |         |
| `guardInput`, role `guardPolicy`     | `clef:latest`            | 147   | 3,045 s (50.7 min) | 15.2 s      | 31.5 s          | 107.5 s |
| `guardInput`, role `guardRisk`       | `granite4.1-guardian:8b` | 294   | 851 s (14.2 min)   | 2.3 s       | 5.9 s           | 9.4 s   |
| `guardInput` in all                  |                          | 441   | 3,897 s (65 min)   |             |                 |         |
| `classify`, role `classify`          | `clef:latest`            | 147   | not finished       | 12.7 s      |                 | 34.9 s  |
| process, write, output guard, select | writers, judge           |       | not measured       |             |                 |         |

How to read it:

- The `classify` row is a snapshot of its first 10 calls. At 13 s per item the whole step would be
  about 32 min (an estimate: 147 times 13 s), so the writers have not started after about 1 h 40 min.
- A `guardPolicy` call sends about 800 tokens and gets a decision, no text. Taking 15 s for that
  (about 55 prompt tokens per second) fits a model that does not fit in memory and is paged
  from swap. It is not proven by the log.
- The slowest `guardPolicy` call (107 s) was the first one: the model was not loaded yet, the call
  hit the 60 s `guardPolicy` timeout, and its retry took another 47 s. Reloading clef for
  `classify` after Granite took 35 s of its 60 s.
- The older `quality` figure (131 items in about 59 minutes, one earlier run) is not comparable:
  it was not measured with per-call timings, and this run needed longer for the input guard alone.

Until a whole `quality` week is measured, treat `light` as the profile that fits a 32 GB laptop.
`digest init` says so, and warns when the RAM it sees is 32 GB, not only when it is less.

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
- Runs: `dist/<monday>/digest/` is small. The raw answers of the sources, saved beside it for each
  week, are the bulk (a feed answer is capped at 5 MiB). Weeks older than `keepWeeks` (12) keep
  only `digest.md` and the delivered digest files, and their fetched data and logs are deleted.
  See [disk and pruning](../operations/disk-and-pruning.md).

## Related

- [Choose a profile and pull models](../runbooks/set-up/choose-profile-and-pull-models.md)
- [Model licences](../reference/model-licences.md)
- [Slow model or out of memory](../runbooks/debug/slow-model-or-out-of-memory.md)
