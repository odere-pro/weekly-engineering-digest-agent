# Config

## Intent

Everything the user can tune lives here: what to watch, how many items to keep, which guards run,
where the digest goes, and which Ollama models do each job. This feature reads and checks
`digest.config.json` and `.env`, keeps secrets apart from settings, and turns a profile name
(`quality`, `fast`, `light`) into concrete model tags for the machine at hand.

## How it works

1. `loadConfig(options)` resolves `digest.config.json` and `.env` (paths can be overridden).
2. `readConfig` reads the JSON and parses it with `ConfigSchema`. A missing file says to run
   `digest init`; bad JSON or a schema problem gives a readable list of fields.
3. `readEnvironment` overlays the process environment on the optional `.env` file. Empty values
   count as unset. `SecretsSchema` and `EnvSchema` then parse the result.
4. `resolveHostPlatform(env)` gives the machine the models run on. `DIGEST_HOST_OS` and
   `DIGEST_HOST_ARCH` override the process, for Docker on a Mac.
5. `resolveProfile(name, platform, writersOverride)` picks the profile, or `NON_MAC_FALLBACK` when
   the platform is not Apple silicon, and applies `models.writers` if set.
6. It returns `LoadedConfig`: `config`, `env`, `secrets`, `profile`, `configPath`, `platform`.
7. Callers use `modelsForRole`, `requiredModels`, `modelsInUse` and `modelsByRole` for model tags.

## Design

- A profile maps each role to a tag (`MODEL_TAGS`). Code asks for roles only. The writer panel is
  `profile.writers`; one writer means no judge and no select step.
- Secrets (`SMTP_PASSWORD`, `SLACK_WEBHOOK_URL`, `GITHUB_TOKEN`) come from `.env` or the process
  environment only. `SLACK_WEBHOOK_URL` must be https. A source URL with `user:pass@` is refused.
- Error messages name fields and rules, never the rejected values.
- There is no setting for the link check or the format check; they cannot be turned off. Guards
  can (`guards.input` and `guards.output`: `enabled`, `mode` any or all, one flag per check).
- Defaults and limits worth knowing: `topN` 3 to 5 (default 5), `windowDays` 1 to 31 (7),
  `focusAreas` 1 to 25 and unique, `dedupeWeeks` 0 to 12 (4), `keepWeeks` at least 1 (12) and not
  below `dedupeWeeks`, `models.retries` 0 to 5 (2), `models.seed` 42, per-role timeout at least
  1,000 ms, thresholds `minRelevance` 1.5, `maxHype` 0.6, `maxMinorRelease` 0.75, `guardFlag` 0.35.
- `modelsInUse` drops the model of a guard role whose checks are all off, so doctor does not ask
  for a model nobody will call.
- `load.ts` also writes `.env` for `digest init`: `mergeEnvText` changes only the keys asked for,
  keeps comments and line endings, and re-reads its own result with the loader's parser. If that
  does not match, it throws and nothing is written. `formatEnvValue` refuses values it cannot quote.
- `redactSecrets(text, secrets)` uses the same redactor as the logger, so both clean text alike.
- `load.ts` is the only file here that reads the disk. Core never imports it.

## Files

| File          | Role                                                                                   |
| ------------- | -------------------------------------------------------------------------------------- |
| `schema.ts`   | Zod schemas and types: `ConfigSchema`, `SecretsSchema` (`SECRET_KEYS`), `EnvSchema`    |
| `profiles.ts` | `PROFILES`, `MODEL_TAGS`, `NON_MAC_FALLBACK`, `resolveProfile`, role and model helpers |
| `load.ts`     | `loadConfig`, `resolveHostPlatform`, `redactSecrets`, `.env` writing helpers           |
| `*.test.ts`   | `schema.test.ts`, `profiles.test.ts`, `load.test.ts`                                   |

There is no `__fixtures__/` here. The test files live in `test/fixtures/config/`.

## Depends on, used by

Depends on: `domain/schemas` (`RoleSchema`, `SourceSchema`), `shared/errors`, and
`observability/redact` (`load.ts` only).
Used by: `app/container` (builds every adapter from it), `digest`, `cli` (most commands),
`guards`, `process`, `sources`, `models/adapters/ollama` (profiles), `evals/`, `test/builders.ts`.

## Change it safely

- Run `pnpm vitest run src/config`. `load.test.ts` reads files from `test/fixtures/config/`
  (`valid.config.json`, `writers.config.json`, `bad-schema.config.json`, `secrets.env`, ...).
- `schema.ts` and `profiles.ts` are frozen on issue branches. Change them on `main` only.
- A new setting needs a default, so existing `digest.config.json` files still load. Update
  `docs/profiles.md` or `docs/operate.md` when users should know.
- Changing a tag in `MODEL_TAGS` changes what `digest doctor` asks users to pull.
- `EVAL_JUDGE` in `profiles.ts` is a model tag (clef). The env variable `EVAL_JUDGE` in
  `EnvSchema` is a different thing: the tag `digest eval` uses to score digests.
- Keep secrets out of `Config`. Never log or echo a secret value in an error.
