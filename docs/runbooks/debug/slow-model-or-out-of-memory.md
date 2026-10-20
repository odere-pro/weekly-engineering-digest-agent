# Debug a slow model or out-of-memory

Part of [Runbooks](../README.md) / Debug.

## Purpose

Find out why model calls are slow, time out or crash Ollama, and change one thing so the run
finishes in a normal time.

## When to use

- A run fails with `Ollama generate call to <model> (role write) timed out after 600000 ms`, or
  the log shows `ollama call failed, retrying`.
- A scheduled run hits the 3 hour limit (`run timed out after 3 h`).
- The machine swaps, or Ollama dies in the middle of a run and the next call reports
  `Ollama is not reachable at <url>`.
- If Ollama was never up, use [Debug a failed run](failed-run.md).

## Prerequisites

- Access to the host that runs Ollama, and to `digest.config.json`.
- Know your profile (`profile` in the config): `quality`, `fast` or `light`.

## Steps

1. Find the slow calls. Each model call logs its `latencyMs` and `attempts`.

   ```bash
   jq -R -c 'fromjson? | select(.msg=="ollama call") | {role, model, latencyMs, attempts}' run.log
   ```

   `pnpm digest show <week>` also lists the time of each step under `Timings:`.

   A long step also logs its own progress, so you can see how far it is and how long is left:

   ```bash
   jq -R -c 'fromjson? | select(.msg=="Progress") | {time, step, label, done, total, eta}' run.log
   ```

   One line comes every 25 items or minute. `eta` is the median time per item so far times the
   items left; it is an estimate, not a promise.

2. Compare your machine with the profile.

   ```bash
   pnpm digest doctor --readiness
   ```

   It prints the RAM and Ollama version it sees and a verdict per profile: `ready`,
   `tight on RAM`, `pull models` or `not for this machine`. `tight on RAM` on `quality` means 32 GiB
   up to 48 GiB, where it swapped when measured; `light` is the way out. `digest init` suggests about
   32 GiB of RAM for `quality` and 16 GiB for `light`. In Docker on a Mac, Ollama runs on the host, because a
   container cannot use the Apple GPU.

3. Keep one model in memory. The steps run one after another and the models are large, so set
   `OLLAMA_MAX_LOADED_MODELS=1` in the environment of the Ollama server and restart Ollama.
   The Compose `ollama` service already sets it. `ollama ps` lists what is loaded.
4. Pick the fix that matches the symptom.

   | Symptom                                | Fix                                                                           |
   | -------------------------------------- | ----------------------------------------------------------------------------- |
   | `timed out after 600000 ms` on `write` | Raise the limit for that role (below)                                         |
   | Guard calls take about a minute each   | Do not turn `think` on for `guardRisk`; it is off by default                  |
   | Swapping, or Ollama killed             | Use a smaller profile, or set one writer in `models.writers`                  |
   | Whole run passes 3 hours               | Same as above; one writer also removes the judge step                         |
   | `guardInput` takes most of the run     | Check `models.rescoreWithWriter`: on, the model input guards check every item |

   Raise a limit in `digest.config.json`. The default per attempt is 60 s for `classify` and
   `guardPolicy`, 120 s for `guardRisk` and `judge`, and 600 s for `write`. The least you can
   set is 1000 ms.

   ```jsonc
   { "models": { "timeoutsMs": { "write": 900000 } } }
   ```

   A failed call is retried `models.retries` times (default 2, at most 5), so one stuck call
   can use three times its limit.

   A call to a model the server has not answered with last (the first call of the run, and the
   first one after the run moves to another model) gets 5 minutes more on every attempt, because
   the model may have to load first, and `clef:latest` took longer than 60 s to. The log line of
   such a call has `coldStart: true`, and its `latencyMs` includes the load. This is not
   configurable. See
   [Change timeouts and retries](../configure/change-timeouts-and-retries.md) and
   [Choose a profile](../set-up/choose-profile-and-pull-models.md).

5. Restart `serve` so it reads the file (`docker compose restart digest`), then test with a
   dry run and compare the timings.

   ```bash
   pnpm digest run --dry-run
   ```

## Verify

`pnpm digest show <week>` lists `Timings:` with no step near its limit, the log has no
`timed out` and no `ollama call failed`, and the status is `dry-run` or `sent`. On the
reference laptop (M1 Pro, 32 GB) the `light` profile took about 6 minutes for a week.

## Roll back

Restore the earlier `models` and `profile` values in `digest.config.json` and restart
`serve`. Nothing else was changed.

## Troubleshooting

| Symptom                                    | Cause                                          | Fix                                                  |
| ------------------------------------------ | ---------------------------------------------- | ---------------------------------------------------- |
| The first call after a pause is slow       | Ollama loads the model again                   | Nothing: a cold call gets 5 min more (below)         |
| A run hangs with no timeout lines          | The process lives, so it keeps its lock        | [Stuck lock](stuck-lock.md)                          |
| `Ollama is not reachable at ...` mid-run   | Ollama crashed, often out of memory            | Restart Ollama, read its log, pick a smaller profile |
| `✗ model <tag>: not installed` in `doctor` | The tag was never pulled                       | `ollama pull <tag>`                                  |
| Docker run is far slower than the host     | The model runs on the CPU inside the container | Use Ollama on the host (Mac) or give it a GPU        |

## Related

- [Cost and hardware](../../overview/cost-and-hardware.md) and [Models](../../features/models.md)
- [Models configuration](../../configuration/models.md) and [Profiles](../../configuration/profiles.md)
- [src/models/CLAUDE.md](../../../src/models/CLAUDE.md)
