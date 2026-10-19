# Models

Part of [Configuration](README.md).

The `models` section overrides parts of the [profile](profiles.md): the writer panel, timeouts,
retries, thinking, and sampling. Every key is optional. Without them the profile decides.

| Key                        | Type                   | Default               | Limits                                   |
| -------------------------- | ---------------------- | --------------------- | ---------------------------------------- |
| `models.writers`           | array of model tags    | the profile's panel   | at least 1, no repeats                   |
| `models.timeoutsMs`        | map of role to number  | per role, see below   | each 1000 or more                        |
| `models.retries`           | integer                | 2                     | 0 to 5                                   |
| `models.think`             | map of role to setting | `guardRisk` off       | `true`, `false`, `low`, `medium`, `high` |
| `models.seed`              | integer                | 42                    | 0 or more                                |
| `models.temperature`       | map of role to number  | `write` 0.2, others 0 | 0 to 2                                   |
| `models.rescoreWithWriter` | boolean                | `false`               | no effect in a run today                 |

Roles are `classify`, `guardPolicy`, `guardRisk`, `write` and `judge`.

```json
{
  "models": {
    "writers": ["gemma4:e4b-mlx"],
    "timeoutsMs": { "write": 900000 },
    "retries": 2,
    "think": { "write": false },
    "seed": 42,
    "temperature": { "write": 0.2 }
  }
}
```

## Writers

`models.writers` replaces the profile's writer panel with any Ollama tags you have pulled. Each
writer drafts the digest in turn. One entry turns the panel off: there is then no judge and no
select step. Two or more entries bring the judge back, even on `light` or `fast` (it uses
`clef:latest` there, which `doctor` then asks you to pull). Tags must be unique. See
[judge](judge.md). The writers are not checked against any list: `digest doctor` and the check
at the start of a run only look that each tag is installed in Ollama.

## Timeouts and retries

Each model call has a time limit per attempt. `models.timeoutsMs` changes it for the roles you list.

| Role          | Default (ms) |
| ------------- | ------------ |
| `classify`    | 60000        |
| `guardPolicy` | 60000        |
| `guardRisk`   | 120000       |
| `judge`       | 120000       |
| `write`       | 600000       |

A call that times out, hits a network or stream error, or gets an HTTP 5xx is retried up to
`models.retries` times, waiting 1 s, then 2 s, doubling up to 10 s. An HTTP 4xx or a bad
payload is not retried. When all attempts fail, the step fails and the run ends `failed`.

## Thinking and sampling

- `models.think` sets Ollama's `think` option for the roles that send it. `guardRisk` defaults to
  off, because Granite Guardian otherwise spends about a minute thinking on each call. Decision
  calls (`guardPolicy`, `judge`, and the normal `classify` path) ignore `think`. `digest doctor`
  warns when you set it for `guardPolicy` or `judge`.
- `models.seed` goes with every generate call. `digest run --seed <n>` overrides it for one run.
- `models.temperature` sets the sampling temperature per role. Unset roles use the defaults above.
- The seed and the temperature of every role are written to `run.json` under `sampling`.

## `models.rescoreWithWriter`

The schema accepts this key and the classify step can use it to re-score relevant items with the
writer model. `digest run` does not switch that on, so the key changes nothing in a normal run.
Only the eval replay (`evals/rescoreReplay.ts`) uses it.

## Change it

- [Change models or writers](../runbooks/configure/change-models-or-writers.md)
- [Change timeouts and retries](../runbooks/configure/change-timeouts-and-retries.md)
- [Set seed and temperature](../runbooks/configure/set-seed-and-temperature.md)
- [Slow model or out of memory](../runbooks/debug/slow-model-or-out-of-memory.md)

## Related

- [Profiles](profiles.md)
- [Models feature](../features/models.md)
- [Classify feature](../features/classify.md)
- [src/models/CLAUDE.md](../../src/models/CLAUDE.md)
