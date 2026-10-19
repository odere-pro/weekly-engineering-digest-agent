# Init prompts

> The questions of `digest init` and the `Answers` they give. Entry: `askAnswers(io, host, recommended)`
> and `defaultAnswers(io, recommended)`, both returning `Answers` (`answers.ts`). Prompts reach the
> terminal only through `io.prompts` (`InitPrompts`).

## Flow

```mermaid
flowchart TD
  askAnswers --> focus["askFocusAreas: defaults pre-ticked, then free text"]
  focus --> profile["askProfile: quality, fast, light"]
  profile --> zone["askTimeZone: default is this process's zone"]
  zone --> channels["checkbox: email, slack"] --> email["askEmail (if ticked)"]
  email --> slack["askSlackWebhook (if ticked)"] --> done["Answers"]
```

## Rules

- A free-text answer is checked as typed (`validate`) and trimmed again when used.
- The SMTP password and Slack webhook are `password` prompts and come back apart from the delivery
  fields: they go to `.env`, never to the config.
- `quality` carries a RAM warning when this process sees under about 32 GB (5% slack); in Docker the
  container limit counts. `light` carries a warning unless the machine that runs Ollama is a Mac:
  in Docker the named `host.hostOs` beats the container's platform.
- Focus areas are unique ignoring case (first spelling wins), 1 to 25: `focusAreasProblem` asks the
  config schema, so the prompt and the file agree.

## Files

| File            | Role                                                          |
| --------------- | ------------------------------------------------------------- |
| `answers.ts`    | `askAnswers`, `defaultAnswers`                                |
| `focusAreas.ts` | `askFocusAreas`, `mergeFocusAreas`, `focusAreasProblem`       |
| `profile.ts`    | `askProfile`, `qualityMemoryWarning`, `PROFILE_DESCRIPTIONS`  |
| `timeZone.ts`   | `askTimeZone`, `isTimeZone`, `isContainerDefaultZone`         |
| `delivery.ts`   | `askEmail`, `askSlackWebhook`                                 |
| `validate.ts`   | `validateWith`, `isEmail`, `splitList`                        |
| `*.test.ts`     | One per file, driven by `scriptedPrompts` (`../__fixtures__`) |

## Gotchas

- Tests answer by matching the question text (`/SMTP host/`, `/Model profile/`): reword a prompt,
  fix the rules.
- `summary/` reuses `QUALITY_UNMEASURED` and `isContainerDefaultZone`. RAM figures: `doctor/readiness/memory.ts`.
