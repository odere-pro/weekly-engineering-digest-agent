# Doctor checks

> One function per question doctor asks: does the config hold keys nothing reads, is Ollama there,
> are the models pulled, do the feeds answer, are the delivery secrets set, which guards are off, can
> `serve` start the schedule. Each returns `CheckResult`s and prints nothing. `doctor.ts` calls them
> in a fixed order.

## Flow

```mermaid
flowchart TD
  keys["unknownKeys.ts: checkUnknownKeys: a warning per config key the schema lacks"] --> host
  host["host.ts: checkOllama, checkVersion, checkAppleSilicon"] --> models["models.ts: checkModels, checkThink"]
  models --> sources["sources.ts: checkSources: one item per source, in parallel, 10 s each"]
  sources --> delivery["delivery.ts: checkDelivery: markdown folder, SMTP_PASSWORD, SLACK_WEBHOOK_URL"]
  delivery --> guards["guards.ts: checkGuards: names each guard check that is off"]
  guards --> schedule["schedule.ts: checkSchedule: serve's cron job built paused, next run or the refusal"]
```

- `checkModels` checks every tag in `modelsInUse` (the `decision` capability on classify, guardPolicy and
  judge) and returns nothing when Ollama is unreachable. `checkAppleSilicon` judges the loader's host.

## Rules

- A check takes only what it needs (a `Pick` of the config, a slice of `DoctorIo`), so a test calls it
  with a few fields. A slow or broken feed is a warning, because a run skips that source.
- Nothing is sent. Delivery looks at whether a secret is set, never at its value.
- `checkOllama` gives an `OLLAMA_URL` with no `http://` or `https://` its own fix line: starting
  Ollama would not help (`hasHttpScheme` from `models/adapters/endpoint`).
- `checkThink` mirrors `effectiveThink` (`models/adapters/chat/chatSettings.ts`), so the two cannot
  drift.
- `checkUnknownKeys` walks the zod 4 shape of `ConfigSchema` (`.def`: object, array, and the optional,
  nullable, default and prefault wrappers) against the raw JSON. It skips records, unions and objects
  with a catchall, and says nothing when the file cannot be read or parsed again. "Did you mean" needs
  exactly one sibling key within two edits (swap of neighbours counts one, case ignored).
- `checkSchedule` uses `new Cron(cron, { timezone, paused: true })`, the same constructor arguments as
  `scheduler.ts`'s `croner` factory, then `nextRun()`: a zone is only checked there. Keep the two in step.
  A cron that never fires is a warning, as in `serve`; an invalid one is an error.
- `INPUT_CHECKS` and `OUTPUT_CHECKS` repeat the guard checks in the order they run (`ruleInjection`
  first); `guards.test.ts` fails when `GuardCheckId` or the guard config gains one they do not list.

## Files

| File             | Role                                               |
| ---------------- | -------------------------------------------------- |
| `host.ts`        | `checkOllama`, `checkVersion`, `checkAppleSilicon` |
| `models.ts`      | `checkModels`, `checkThink`, `describeThink`       |
| `sources.ts`     | `checkSources`, `checkSource`, `SOURCE_TIMEOUT_MS` |
| `delivery.ts`    | `checkDelivery`                                    |
| `guards.ts`      | `checkGuards`, `INPUT_CHECKS`, `OUTPUT_CHECKS`     |
| `schedule.ts`    | `checkSchedule`                                    |
| `unknownKeys.ts` | `checkUnknownKeys`, `findUnknownKeys`              |

Tests are one per check, on the shared fake machine `../__fixtures__/doctorHarness.ts`.

## Gotchas

- `checkAppleSilicon` has a "not required" branch that no profile reaches today, since all three
  need Apple silicon. Keep it until a profile does not.
