# The config file

Part of [Configuration](README.md).

`digest.config.json` is the one file that decides what the agent does. This page covers where it
lives, how it is checked, and when a change takes effect.

## Where it lives

- Node: `digest.config.json` in the folder you run `digest` from. Pick another file with the
  global option, before the command name: `pnpm digest -c ./staging.json doctor`.
- Docker: the file in the project folder is bind-mounted at `/app/digest.config.json`. It must
  exist before the first run (`make docker-init` creates it). Run commands as
  `docker compose run --rm digest <command>`.
- `digest init` (or `make docker-init` on a Mac) writes it, and `.env` next to it. Both are
  git-ignored.

## Format and checks

- Plain JSON. No comments and no trailing commas.
- Only `focusAreas` and `sources` are required. Everything else has a default.
- Every command that needs the config reads and checks it at the start. A problem stops the
  command and names the field.
- Unknown keys are ignored without a warning. A typo such as `windowDay` is dropped and the
  default for `windowDays` applies. Compare your keys with the
  [config keys reference](../reference/config-keys.md) when a setting seems to do nothing.
- The file holds no secrets. A source URL with `user:pass@` is refused. Secrets go in
  [`.env`](environment.md).

Rules that span several keys:

| Rule                                                     | Keys                       |
| -------------------------------------------------------- | -------------------------- |
| `keepWeeks` must be at least `dedupeWeeks`               | `keepWeeks`, `dedupeWeeks` |
| Focus areas are unique, ignoring case                    | `focusAreas`               |
| Source ids are unique                                    | `sources` (the `id` field) |
| Writers are unique: outcomes and scores are keyed by tag | `models.writers`           |

## What an error looks like

```text
Invalid config in /work/digest.config.json:
✖ Too big: expected number to be <=31
  → at windowDays
```

The other two messages are `No digest.config.json found at <path>. Run "digest init" first.` and
`Invalid JSON in <path>: <reason>`.

## When a change takes effect

| Command                                     | Reads the file                                 |
| ------------------------------------------- | ---------------------------------------------- |
| `run`, `doctor`, `fetch`, `eval`, and so on | Each time it starts, so the next run uses it   |
| `serve` (the Docker service)                | Once, when it starts. Restart it after an edit |

After you edit the file for a running service, restart it:
`docker compose restart digest`. A run already in progress keeps the settings it started with.

## Check your edit

```bash
pnpm digest doctor
```

`doctor` loads the file, prints `config: loaded <path> (profile <name>)`, and warns about guards
that are off. It does not validate `schedule.cron` or `schedule.timeZone`: `serve` reports a bad
schedule when it starts (see [schedule](schedule.md)).

## Change it

- [Add a source](../runbooks/configure/add-a-source.md)
- [Change the focus areas](../runbooks/configure/change-focus-areas.md)
- [Change the output folder](../runbooks/configure/change-the-output-folder.md)
- [Set up the first run](../runbooks/set-up/first-run.md)

## Related

- [Config keys reference](../reference/config-keys.md)
- [Files and paths](../reference/files-and-paths.md)
- [Environment](environment.md)
- [src/config/CLAUDE.md](../../src/config/CLAUDE.md)
