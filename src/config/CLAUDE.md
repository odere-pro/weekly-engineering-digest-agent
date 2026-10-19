# Config

> Everything the user can tune: reads and checks `digest.config.json` and `.env`, keeps secrets apart
> from settings, and turns a profile name into model tags for the machine at hand.
> Entry: `loadConfig(options) → Promise<LoadedConfig>` (`load.ts`). It owns no port.

## Context

```mermaid
flowchart LR
  file[("digest.config.json")] -.-> load:::focus
  env[(".env and process env")] -.-> load
  load -.->|"parse"| schema:::focus
  load -.->|"resolveProfile"| profiles:::focus
  dom["domain/schemas, models/roles"] -->|"SourceSchema, RoleSchema"| schema
  load -->|"LoadedConfig"| callers["cli, evals"] -->|"LoadedConfig"| app["app/container"]
  schema -->|"Config, GuardsConfig, Thresholds"| core["digest, guards, process"]
  profiles -->|"ModelProfile, modelsInUse, modelsByRole"| digest["digest: health, record"]
  profiles -->|"ModelProfile, modelsForRole"| ollama["models/adapters/call"]
  classDef focus stroke-width:3px
```

## Flow

```mermaid
flowchart TD
  read["loadConfig: readConfig, JSON then ConfigSchema"] -->|"no file, bad JSON, bad schema"| err["DigestError: field names and rules, never values"]
  read --> envs["readEnvironment: .env, process env on top, empty means unset"]
  envs -->|"SecretsSchema or EnvSchema fails"| err
  envs --> plat["platform: option, else DIGEST_HOST_OS and DIGEST_HOST_ARCH, else process"]
  plat -->|"invalid host value"| err
  plat --> prof{"Apple silicon?"}
  prof -->|"no: NON_MAC_FALLBACK"| out["LoadedConfig, with models.writers replacing the writer panel"]
  prof -->|"yes: PROFILES[config.profile]"| out
```

- Writers override: more than one writer gets the profile's judge, else `OVERRIDE_JUDGE` (`clef`); one
  writer means no judge and no select step. The profile table is in `docs/configuration/profiles.md`.
- Tags per role: `modelsForRole` (`write` returns the panel), `requiredModels`, `modelsByRole`.
  `modelsInUse` drops a guard role whose checks are all off, so doctor does not ask for its model.
- Folders: `dataDir` (`dist`) holds everything the project produces, laid out by `store/layout.ts`.
  `delivery.markdown.dir` has no default: unset, the Markdown files go to each week's `digest/` folder.

## Rules

- Secrets come from `.env` or the process environment only, never `digest.config.json`.
  `SLACK_WEBHOOK_URL` must be https (its secret path must not travel in clear). A source URL with
  `user:pass@` is refused: `fetch` echoes the whole URL into errors, logs and run records.
- Error messages name fields and rules, never the rejected values (`z.prettifyError`). A new
  setting needs a default, so existing `digest.config.json` files still load.
- A source id must not be `digest`: a source's folder shares the day folder with the week's
  `digest/` (`isReservedSourceId`, `store/layout.ts`).
- `keepWeeks >= dedupeWeeks`: a pruned week drops out of cross-week dedupe. `writers` are unique:
  outcomes and scores are keyed by tag. `focusAreas` are unique, 1-25: decision models take 26 options.
- The judge never shares a model family with a writer (`modelFamily`, `clef` counts as `qwen`):
  `resolveProfile` throws a `DigestError` at config load, naming the writer and the judge.
- `mergeEnvText` (for `digest init`) changes only the keys asked for, keeps comments and line endings,
  and re-reads its result with the loader's parser (`parseEnv`): if that differs it throws and
  nothing is written. `formatEnvValue` refuses a value it cannot quote.

## Files

| File          | Role                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------- |
| `schema.ts`   | `ConfigSchema`, `SecretsSchema` (`SECRET_KEYS`), `EnvSchema` and their types                                  |
| `profiles.ts` | `PROFILES`, `MODEL_TAGS`, `NON_MAC_FALLBACK`, `resolveProfile`, `OVERRIDE_JUDGE`, `modelFamily`, role helpers |
| `load.ts`     | `loadConfig`, `platformOf`, `resolveHostPlatform`, `redactSecrets`, `mergeEnvText`, `formatEnvValue`          |

Tests sit next to each file. `load.test.ts` reads `test/fixtures/config/` and pins the error texts.

## Gotchas

- `schema.ts` and `profiles.ts` are frozen (`.claude/rules/parallel-work.md`). A `MODEL_TAGS` change
  alters what `digest doctor` asks users to pull. A new setting goes in `docs/configuration/` and
  `docs/reference/config-keys.md`.
- The keys of `guards.input|output.checks` decide which guards the guard step runs (`planGuards`).
- Two judges, two names: the env variable `EVAL_JUDGE` (`EnvSchema`) is the tag `digest eval` scores
  digests with; `OVERRIDE_JUDGE` (`profiles.ts`) is the judge a multi-writer override gets.
- `redactSecrets` here takes the `Secrets` object and does not add the Slack webhook path
  (`app/redaction/knownSecrets` does); `delivery/adapters/errors/redact.ts` has another over `string[]`.
