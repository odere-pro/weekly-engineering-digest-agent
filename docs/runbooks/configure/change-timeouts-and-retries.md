# Change timeouts and retries

Part of [Runbooks](../README.md) / [Configure](README.md).

## Purpose

Give a slow model more time, or change how often a failed model call is tried again. Only model
calls to Ollama are configurable.

## When to use

- A run fails with `Ollama ... call to <tag> (role <role>) timed out after N ms`.
- A big writer needs longer than 10 minutes, or a small one should fail fast.
- The cause may be too little memory or a wrong profile: look at
  [Slow model or out of memory](../debug/slow-model-or-out-of-memory.md) first.

## Prerequisites

- You know which role timed out. The error and the log line `ollama call failed` name it.
- Write access to `digest.config.json`.

## Steps

1. Know the keys. A timeout is per attempt, so one call can take up to
   `(retries + 1) x timeout` plus the waits between attempts.

   | Key                        | Rule                       | Default                                                                         |
   | -------------------------- | -------------------------- | ------------------------------------------------------------------------------- |
   | `models.timeoutsMs.<role>` | whole number, 1000 or more | classify 60000, guardPolicy 60000, guardRisk 120000, judge 120000, write 600000 |
   | `models.retries`           | whole number, 0 to 5       | 2 extra attempts                                                                |

   A call to a model that is not loaded yet (the first call of the run, or after the run moves to
   another model) gets 5 minutes more on every attempt, on top of these. That time is not
   configurable. Its log line has `coldStart: true`.

   Roles are `classify`, `guardPolicy`, `guardRisk`, `write` and `judge`. Retries wait 1 s, then
   2 s and so on, capped at 10 s. A timeout, a network error, a broken stream or an HTTP 5xx is
   tried again. An HTTP 4xx, a bad payload and a call you aborted are not.

2. Edit `digest.config.json`. Leave out the roles you do not change.

   ```json
   {
     "models": {
       "timeoutsMs": { "write": 900000 },
       "retries": 1
     }
   }
   ```

3. Apply the change. `digest serve` reads the config once, at start. In Docker:
   `docker compose restart digest`. A manual `pnpm digest run` and a host timer read the file
   again each time. In Docker, other commands are `docker compose run --rm digest <command>`.
4. Check that the file loads.

   ```bash
   pnpm digest doctor
   ```

What you cannot change from the config:

- Feeds: 10 s per attempt and 2 retries (after 0.5 s and 1 s), 4 sources at a time.
  `digest fetch` and the `source` checks of `digest doctor` try once, with the same 10 s.
- Email and Slack: 2 retries after 5 s and 10 s, only when nothing was sent. SMTP times out at
  15 s (connect), 15 s (greeting) and 30 s (socket); Slack at 15 s.
- `serve`: a run may take 3 hours, a held lock is retried every 5 minutes for 2 hours, and a
  failed run is retried twice, 30 minutes apart.

## Verify

- Doctor shows no `✗ config` line. A bad value gives `Too small: expected number to be >=1000`
  or `Too big: expected number to be <=5`.
- After a run, the log line `ollama call` carries `attempts` and `latencyMs` for each call.
  A line `ollama call failed, retrying` means a retry happened. Set `LOG_LEVEL=debug` in `.env`
  for more detail ([Read logs](../observe/read-logs.md)).

## Roll back

Delete `timeoutsMs` or `retries` from `models` (the defaults return) and restart as in step 3.

## Troubleshooting

| Symptom                                                                | Cause                                   | Fix                                 |
| ---------------------------------------------------------------------- | --------------------------------------- | ----------------------------------- |
| `Too small: expected number to be >=1000` at `models.timeoutsMs.write` | The value is in seconds, not ms         | Multiply by 1000                    |
| `Unrecognized key: "writer"` at `models.timeoutsMs`                    | The role is called `write`              | Use a role name from step 1         |
| `Too big: expected number to be <=5` at `models.retries`               | More than 5 retries                     | Use 0 to 5                          |
| Still timing out at the new limit                                      | The model is too large for this machine | Use a smaller profile or one writer |
| A run takes hours after raising `retries`                              | Each retry waits a full timeout         | Lower `retries`, or fix the model   |
| The change does not apply                                              | `serve` was not restarted               | Restart as in step 3                |

## Related

- [Models](../../configuration/models.md), [Collection limits](../../configuration/collection-limits.md)
- [Delivery retries](../../operations/delivery-retries.md), [Feeds](../../operations/feeds.md)
- [Config keys](../../reference/config-keys.md), [src/models/CLAUDE.md](../../../src/models/CLAUDE.md)
