# Config

Part of [Features](README.md).

## What it is for

Everything you can tune lives here: what to watch, how many items to keep, which guards run, where
the digest goes and which Ollama models do each job. This feature reads and checks
`digest.config.json` and `.env`, keeps secrets apart from settings, and turns a profile name
(`quality`, `fast` or `light`) into concrete model tags for the machine at hand.

## Where it sits

It is the first thing every command does, and the input of the app wiring. See
[feature folders](../architecture/feature-folders.md).

## What it does

- Reads `digest.config.json` (set another path with the global option `-c, --config <path>`) and
  checks it against a schema. A missing file tells you to run `digest init`. Bad JSON or a wrong
  value gives a list of the fields at fault. Messages name fields and rules, never the values.
- Reads `.env` and overlays the process environment on it. The process environment wins and an
  empty value counts as unset. Secrets (`SMTP_PASSWORD`, `SLACK_WEBHOOK_URL`, `GITHUB_TOKEN`) are
  read from here only, never from the config file.
- Applies the limits. Examples: `topN` 3 to 5 (default 5), `windowDays` 1 to 31 (default 7),
  `focusAreas` 1 to 25 unique entries, `dedupeWeeks` 0 to 12 (default 4), `keepWeeks` at least 1
  (default 12) and not below `dedupeWeeks`, `models.retries` 0 to 5 (default 2), `models.seed` 42.
- Refuses a source URL that contains `user:pass@`, and a `SLACK_WEBHOOK_URL` that is not https.
- Works out which machine the models run on. `DIGEST_HOST_OS` and `DIGEST_HOST_ARCH` override the
  process, for Docker on a Mac. On anything but Apple silicon every profile resolves to an untuned
  fallback set, and `digest doctor` says so.
- Turns the profile into model tags per role and applies `models.writers` if set. The writer panel
  is `profile.writers`; one writer means no judge and no select step.
- Skips the model of a guard role whose checks are all off, so `doctor` and the start-up check do
  not ask for a model nobody will call.
- Has no setting for the link check or the format check. Guards can be switched off; those two
  cannot.
- Writes `.env` for `digest init`: it changes only the keys asked for, keeps comments and line
  endings, and stops without writing if it cannot read its own result back the same.

## What you can configure

This feature is where every setting is defined. The pages for each group:

- Whole file: [config file](../configuration/config-file.md), [profiles](../configuration/profiles.md),
  [environment](../configuration/environment.md).
- Content: [focus areas](../configuration/focus-areas.md), [sources](../configuration/sources.md),
  [collection limits](../configuration/collection-limits.md).
- Behaviour: [guards](../configuration/guards.md), [thresholds](../configuration/thresholds.md),
  [models](../configuration/models.md), [judge](../configuration/judge.md),
  [schedule](../configuration/schedule.md).
- Output: [Markdown](../configuration/delivery-markdown.md),
  [email](../configuration/delivery-email.md), [Slack](../configuration/delivery-slack.md).
- Lookup tables: [config keys](../reference/config-keys.md) and
  [environment variables](../reference/environment-variables.md).

## What can go wrong

- Invalid config: the command exits with 1 and prints the fields to fix. Run `pnpm digest doctor`
  for a line per problem, each with a `fix:` hint.
- A `.env` value with a `#` in it is read as a comment from the `#` on, so a password can be cut
  short. Quote the value. `doctor` warns about this and about a `.env` readable by other users.
- A source URL with a password, or an `http` webhook, is refused with a message that names the
  field only.
- `models.rescoreWithWriter` is accepted but has no effect in a real run today.
- Config is read once when a command starts. `digest serve` needs a restart to see a change. See
  [stopping and restarts](../operations/stopping-and-restarts.md).
- A change that is easy to get wrong has a runbook, for example
  [change thresholds](../runbooks/configure/change-thresholds.md) or
  [change models or writers](../runbooks/configure/change-models-or-writers.md).

## Code and tests

- Folder: [src/config/](../../src/config/). Maintainer notes: [CLAUDE.md](../../src/config/CLAUDE.md).
- No port. Only the loader in that folder reads the disk; the schema and profiles are pure.
- Tests sit next to the code and read sample files from [test/fixtures/config](../../test/fixtures/config/).

## Related

- [domain](domain.md) defines the shared types the config refers to (the model roles
  are in `src/models/roles.ts`). [app](app.md) builds the
  adapters from the loaded config. [cli](cli.md) loads it for each command.
- [models](models.md) and [guards](guards.md) are the biggest users of the profile and the guard
  settings.
