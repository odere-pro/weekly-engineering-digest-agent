# Doctor checks

## Intent

One function per question doctor asks: is Ollama there, are the models pulled, do the feeds answer,
are the delivery secrets set, which guards are off. Each returns `CheckResult`s and prints nothing.

## How it works

1. `host.ts`: `checkOllama` (reachable, version listed, then `checkVersion` against the profile
   minimum) and `checkAppleSilicon` (judges the host the loader resolved).
2. `models.ts`: `checkModels` (every tag in `modelsInUse`, with the `decision` capability for
   classify, guardPolicy and judge) and `checkThink` (the effective `think` per role).
3. `sources.ts`: `checkSources` reads one item from every source in the last day with the real
   fetchers, in parallel, within `SOURCE_TIMEOUT_MS` (10 s).
4. `delivery.ts`: `checkDelivery` checks the markdown folder (with no `delivery.markdown.dir` it
   says digests go to each week's folder in the data folder, which the data dir check covers), then
   `SMTP_PASSWORD` (if email is configured) and `SLACK_WEBHOOK_URL` (if Slack is enabled).
5. `guards.ts`: `checkGuards` names each guard check that is off.

## Design

- A check takes only what it needs (`Pick` of the config, a slice of `DoctorIo`), so a test calls
  it with a few fields instead of a whole machine.
- Severity: a missing model, an old Ollama, a blocked folder or a missing secret is an error. A
  slow or broken feed is a warning, because a run skips that source.
- `checkModels` returns nothing when Ollama is unreachable or could not list models. The ollama
  check already failed.
- `checkThink` mirrors `effectiveThink`, the adapter's own rule, so the two cannot drift.
- Nothing is sent. Delivery looks at whether a secret is set, never at its value.
- `INPUT_CHECKS` and `OUTPUT_CHECKS` repeat the guard checks, in the order they run
  (`ruleInjection` first). `guards.test.ts` fails when `GuardCheckId` or the guard config gains a
  check they do not list.

## Files

| File          | Role                                                                    |
| ------------- | ----------------------------------------------------------------------- |
| `host.ts`     | `checkOllama`, `checkVersion`, `checkAppleSilicon`                      |
| `models.ts`   | `checkModels`, `checkThink`, `describeThink`                            |
| `sources.ts`  | `checkSources`, `checkSource`, `SOURCE_TIMEOUT_MS`                      |
| `delivery.ts` | `checkDelivery`                                                         |
| `guards.ts`   | `checkGuards`, `INPUT_CHECKS`, `OUTPUT_CHECKS`                          |
| `*.test.ts`   | Direct tests per check, plus the cases that run through `doctorCommand` |

## Depends on, used by

Depends on: `report/` (results), `folders/` (delivery), `readiness/version` (version and tag
helpers), `config`, `models/adapters/ollama`, `sources/adapters`, `shared`.
Used by: `doctor.ts`.

## Change it safely

- Run `pnpm vitest run src/cli/doctor/checks`. The shared fake machine is
  `../__fixtures__/doctorHarness.ts`.
- Result order and label text are public: tests find lines by `label:`.
- A new check is a new function here, one line in `doctorCommand` and a test with the harness.
- `checkAppleSilicon` has a "not required" branch that no profile reaches today, since all three
  need Apple silicon. Keep it until a profile does not.
