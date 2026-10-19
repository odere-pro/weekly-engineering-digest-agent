# Init summary

> What `digest init` prints after it wrote the files. Entry: `summary(info) → string` and
> `dockerNextSteps(timeZone) → string` (`summary.ts`).

## Flow

```mermaid
flowchart TD
  info["configPath, envPath, answers, ollamaUrl, envMerged"] --> summary
  summary --> wrote{"envMerged?"}
  wrote -->|yes| updated["Wrote config and updated .env, kept its other settings"]
  wrote -->|no| fresh["Wrote config and .env"]
  updated & fresh --> lines["profile, quality note, focus, delivery, schedule, ollama"]
  zone["timeZone"] --> docker["dockerNextSteps"] --> utc{"UTC or Etc/UTC?"}
  utc -->|yes| warn["The schedule runs on UTC: set schedule.timeZone"]
  utc -->|no| next["Next: docker compose up -d"]
```

## Rules

- No secret in the output: the delivery line lists channel names only, never the password or the
  webhook. A test checks it.
- `quality` gets a note that it is unmeasured and how to switch to `light`; the other profiles get
  none.
- In Docker the schedule is the compose service's, so the notes talk about the time zone: a
  container on UTC runs the Monday 07:45 digest at 07:45 UTC.

## Files

| File         | Role                                                    |
| ------------ | ------------------------------------------------------- |
| `summary.ts` | `summary`, `dockerNextSteps`                            |
| `*.test.ts`  | Exact text for the plain, merged, quality and UTC cases |

## Gotchas

- Tests pin the text, line by line.
- `QUALITY_UNMEASURED` (`prompts/profile.ts`) and `isContainerDefaultZone` (`prompts/timeZone.ts`)
  are shared with the prompts, so the question and the summary say the same thing.
