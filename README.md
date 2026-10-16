# Engineering Digest Agent

A local-first agent that writes a weekly digest of the 3-5 AI and platform engineering
releases that matter. It runs end to end on [Ollama](https://ollama.com) at zero cost.

Once a week it reads a list of RSS/Atom feeds and GitHub releases, checks the text with
guards, picks the items that matter, writes the digest with a panel of models, checks the
result, and delivers it as Markdown, email or Slack.

> Status: pre v0.1.0. The package is not published to npm; install from a clone.

Contents: [Install](#install) · [Commands](#commands) · [Configuration](#configuration) ·
[Profiles](#profiles) · [Model licences](#model-licences) · [Guards](#guards) ·
[Troubleshooting](#troubleshooting). The run-by-run fixes are in
[`docs/runbook.md`](docs/runbook.md). The design is in [`docs/system-design.md`](docs/system-design.md).

## Install

| Path                         | Best for                                    | Needs                                                     |
| ---------------------------- | ------------------------------------------- | --------------------------------------------------------- |
| Docker Compose (recommended) | A weekly schedule that runs by itself       | Docker with Compose 2.24 or newer, Ollama (see below)     |
| Node CLI                     | Trying it, or a host scheduler (launchd...) | Node 24 or newer, pnpm, Ollama installed on the same host |

The `quality` profile needs about 32 GB of RAM and 40 GB of disk. The `light` profile fits in 16 GB
of RAM. See [Profiles](#profiles).

### Docker Compose on a Mac

Docker on macOS cannot use the Apple GPU. The app runs in a container and talks to the Ollama
app on the host. Install and start the [Ollama app](https://ollama.com/download) first.

```bash
git clone https://github.com/odere-pro/weekly-engineering-digest-agent.git
cd weekly-engineering-digest-agent
make docker-init   # creates digest.config.json and .env, then runs "digest init"
make docker-up     # starts the weekly scheduler (docker compose up -d)
```

`make docker-*` tells the container that the host is a Mac, so it picks the Mac model profiles.
Without `make`, export the same values yourself:

```bash
touch digest.config.json && (umask 077 && touch .env)
export DIGEST_HOST_OS=darwin DIGEST_HOST_ARCH=arm64
docker compose run --rm --no-deps digest init
docker compose up -d
```

Pull the models your profile needs on the host with `ollama pull <tag>`. `digest doctor` prints
the exact `ollama pull` line for each missing model.

### Docker Compose on Linux

Compose adds its own Ollama and pulls the models once into the `ollama-models` volume.

```bash
git clone https://github.com/odere-pro/weekly-engineering-digest-agent.git
cd weekly-engineering-digest-agent
mkdir -p data && touch digest.config.json && (umask 077 && touch .env)
echo "DIGEST_UID=$(id -u)" >> .env && echo "DIGEST_GID=$(id -g)" >> .env
docker compose run --rm --no-deps digest init
docker compose --profile linux up -d
```

- `DIGEST_UID` and `DIGEST_GID` let the container write `./data` and read a `chmod 600` `.env`.
- Linux has no MLX models, so every profile uses the untuned fallback (see [Profiles](#profiles)).
- To use an NVIDIA GPU, enable `gpus: all` in `docker-compose.yml` (needs the NVIDIA Container
  Toolkit). Without it the models run on the CPU.
- Set `REFRESH_MODELS=1` to pull models that are already present.

### Docker Compose: daily use

| Task                       | Command                                                                        |
| -------------------------- | ------------------------------------------------------------------------------ |
| Start the weekly scheduler | `docker compose up -d` (Linux: add `--profile linux`)                          |
| Stop it                    | `docker compose down`                                                          |
| Check the setup            | `docker compose run --rm digest doctor`                                        |
| Trial run, nothing is sent | `docker compose run --rm digest run --dry-run`                                 |
| List past runs             | `docker compose run --rm digest history`                                       |
| Follow the logs            | `docker compose logs -f digest`                                                |
| Add Jaeger traces          | `docker compose --profile tracing up -d` (see [Configuration](#configuration)) |

`digest serve` is the default command of the container. It runs the digest on the cron in
`schedule.cron` (default Monday 07:45) in `schedule.timeZone`. If it starts after the slot has
passed and the week has no sent digest, it runs that week at once. On stop it waits for a
running digest to finish.

### Node CLI

```bash
git clone https://github.com/odere-pro/weekly-engineering-digest-agent.git
cd weekly-engineering-digest-agent
pnpm install --frozen-lockfile
pnpm digest init            # runs from source with tsx, no build needed
pnpm digest doctor
pnpm digest run --dry-run
```

To get a standalone `dist/cli.js`, run `pnpm build`, then `node dist/cli.js <command>`.

Without Docker, `digest init` also prints a schedule for your OS: a launchd plist (macOS), a
systemd user timer (Linux) or a `schtasks` line (Windows) that calls `digest run`. Those fire in
the machine's local time, not in `schedule.timeZone`. You can also keep `digest serve` running.

## Commands

Run every command as `pnpm digest <command>` (from source), `node dist/cli.js <command>` (built),
or `docker compose run --rm digest <command>` (Docker). All commands take the global option
`-c, --config <path>` (default `digest.config.json`), placed before the command name.

| Command                          | What it does                                                                             |
| -------------------------------- | ---------------------------------------------------------------------------------------- |
| `digest init [-y, --yes]`        | Asks for focus areas, profile, time zone and delivery; writes the config and `.env`      |
| `digest doctor`                  | Checks config, Ollama, models, every feed, delivery secrets, guards and the data dir     |
| `digest run`                     | One full run. See the options below                                                      |
| `digest history [-n, --limit N]` | Lists past runs: week, status, item counts, duration, winner (default 12 runs)           |
| `digest eval [--profile name]`   | Runs the eval set and prints a scorecard. `name` is `quality`, `fast`, `light`, or `all` |
| `digest serve`                   | Runs the weekly scheduler in the foreground. This is the Compose service                 |

Options of `digest run`:

| Option         | Meaning                                                                  |
| -------------- | ------------------------------------------------------------------------ |
| `--since <N>d` | Collection window in days, from `1d` to `31d`. Default: `windowDays` (7) |
| `--dry-run`    | Writes the digest to disk. Sends nothing, no failure note                |
| `--force`      | Runs again even if the week already has a sent digest                    |

`init --yes` accepts the defaults without asking. It refuses to overwrite a config or `.env` that
already has content (exit 1). Without `--yes`, `init` asks before it overwrites.

### Exit codes

| Code | Meaning                                                                             |
| ---- | ----------------------------------------------------------------------------------- |
| 0    | Success: `sent`, `dry-run` or `skipped`. Also the result of `doctor` with no errors |
| 1    | Failed: a step error, a held lock, an invalid config. `doctor`: at least one error  |
| 2    | Blocked: every draft was rejected by the checks or guards                           |
| 3    | Quiet week: no items collected, or fewer than 3 items worth sending                 |

`digest eval` exits 1 when a hard gate fails, otherwise 0. `digest history` exits 0, or 1 on a
config error. `digest serve` exits 0 after a stop signal.

### Run statuses

`digest run` prints the week, status, item counts, winner, duration, failed sources and rejected
drafts. The same data is in `data/runs/<week>/run.json`.

| Status    | Meaning                                                     | Exit |
| --------- | ----------------------------------------------------------- | ---- |
| `sent`    | The winning digest reached every channel                    | 0    |
| `dry-run` | `--dry-run` and a winner was picked; nothing was sent       | 0    |
| `skipped` | The week already has a sent digest and `--force` is not set | 0    |
| `quiet`   | No items collected, or fewer than 3 selected                | 3    |
| `blocked` | Every draft was rejected                                    | 2    |
| `failed`  | A health check, a step or a delivery failed                 | 1    |

## Configuration

`digest init` writes two files in the working directory. Both are ignored by git.

- `digest.config.json` holds everything except secrets. It is validated at startup, and an
  error names the field. [`digest.config.example.json`](digest.config.example.json) shows a full
  file with the default sources.
- `.env` holds secrets and environment settings. `init` writes it with mode 600.

Recipients, webhooks and endpoints come from these two files only, never from model output.

### `digest.config.json`

| Field               | Default                  | Meaning                                                                                               |
| ------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------- |
| `profile`           | `quality`                | `quality`, `fast` or `light`                                                                          |
| `focusAreas`        | required                 | 1-25 unique topics the classifier sorts items into                                                    |
| `sources`           | required                 | The allowlist of feeds. Each has `id`, `kind` (`rss` or `github`), `url`, `area`, optional `maxItems` |
| `windowDays`        | 7                        | How far back to collect (1-31)                                                                        |
| `maxItemsPerSource` | 20                       | Newest items kept per source (1-100)                                                                  |
| `topN`              | 5                        | Items in the digest (3-5)                                                                             |
| `dedupeWeeks`       | 4                        | Weeks of already sent URLs removed from new digests (0-12)                                            |
| `keepWeeks`         | 12                       | Run folders older than this keep only `digest.md`. Must be at least `dedupeWeeks`                     |
| `dataDir`           | `data`                   | Where runs and the lock live                                                                          |
| `schedule`          | `45 7 * * 1`, local zone | `cron` and `timeZone` for `serve`                                                                     |
| `delivery`          | Markdown only            | `markdown.dir` (default `data/digests`), optional `email`, optional `slack`                           |
| `guards`            | all on                   | See [Guards](#guards)                                                                                 |
| `thresholds`        | see below                | Cut-offs applied after classification                                                                 |
| `models`            | profile defaults         | `writers`, `timeoutsMs`, `retries` (default 2), `think`                                               |

Thresholds: `minRelevance` 1.5 (0-3), `maxHype` 0.5, `maxMinorRelease` 0.5, `guardFlag` 0.5.

`models.writers` replaces the writer panel. One entry turns the panel and the judge off.

Email needs `delivery.email` with `host`, `user`, `from` and `to`; `port` defaults to 587 and
`requireTLS` to `true`. Slack needs `delivery.slack = { "enabled": true }`.

Sources are listed in [`docs/sources.md`](docs/sources.md). A GitHub source URL must be exactly
`https://github.com/<owner>/<repo>`.

### `.env`

| Variable                             | Meaning                                                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `SMTP_PASSWORD`                      | Needed when `delivery.email` is set                                                                                            |
| `SLACK_WEBHOOK_URL`                  | Needed when `delivery.slack.enabled` is true                                                                                   |
| `GITHUB_TOKEN`                       | Optional. Higher GitHub rate limits; uses the REST API instead of the Atom feed                                                |
| `OLLAMA_URL`                         | Default `http://localhost:11434`. `init` sets it for Docker on a Mac. In Docker never use `localhost`                          |
| `LOG_LEVEL`                          | `debug`, `info` (default), `warn` or `error`                                                                                   |
| `OTEL_EXPORTER_OTLP_ENDPOINT`        | Set it to turn on OpenTelemetry traces                                                                                         |
| `DIGEST_HOST_OS`, `DIGEST_HOST_ARCH` | The OS and CPU of the machine that runs Ollama, when the app runs in a container on a different one. `make docker-*` sets them |
| `TZ`, `DIGEST_UID`, `DIGEST_GID`     | Docker only. Time zone of the container, and the user the container runs as                                                    |

Values from the process environment win over `.env`. Secrets never reach logs, run records or
traces. `doctor` warns when `.env` is readable by other users (`chmod 600 .env` fixes it).

### Tracing

```bash
# in .env or the shell:
OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318/v1/traces
docker compose --profile tracing up -d
```

The Jaeger UI is on `http://localhost:16686`. Compose cannot turn the variable on by profile, so
you must set it yourself.

## Profiles

A profile maps each role to an Ollama model tag. Set it with `"profile"` in the config.

| Profile   | Classify and policy guard     | Risk guard               | Writers                                            | Judge         | Memory                      | Speed            | Quality          |
| --------- | ----------------------------- | ------------------------ | -------------------------------------------------- | ------------- | --------------------------- | ---------------- | ---------------- |
| `quality` | `clef:latest`                 | `granite4.1-guardian:8b` | `gemma4:31b-mlx`, `nemotron-3.5-lightning:30b-mlx` | `clef:latest` | about 32 GB RAM, 40 GB disk | not measured yet | not measured yet |
| `fast`    | `strands-decider:2b-mlx-bf16` | `granite4.1-guardian:8b` | `nemotron-3.5-lightning:30b-mlx`                   | none          | not measured yet            | not measured yet | not measured yet |
| `light`   | `strands-decider:2b-mlx-bf16` | `granite4.1-guardian:8b` | `gemma4:e4b-mlx`                                   | none          | fits in 16 GB RAM           | not measured yet | not measured yet |

- The memory figures for `quality` and `light` are the sizes `digest init` shows. The other
  cells have no numbers yet because the evals have not run. They will move to `docs/profiles.md`.
- The `quality` profile writes with both models and the judge picks the better draft. The other
  two profiles have one writer, so there is no judge step.
- Steps run one after another, so one model is in memory at a time. Set
  `OLLAMA_MAX_LOADED_MODELS=1` on a host Ollama.
- The MLX tags and `strands-decider` need an Apple silicon Mac and Ollama 0.40.0 or newer. On any
  other machine every profile falls back to the untuned set: `clef:latest`,
  `granite4.1-guardian:8b` and `gemma4:31b`, with no judge (Ollama 0.35.1 or newer).
- `init` recommends `quality` on a machine with 32 GB of RAM or more, otherwise `light`.

## Model licences

The repo ships model tags only, never weights. You accept each model's licence when you run
`ollama pull`. This table is a reading of public pages on 2026-10-16. It is **not legal advice**.
Full notes and sources are in [`docs/licences.md`](docs/licences.md).

| Model (tag used)                                | Licence                                                                                     | Commercial use    |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------- |
| clef (`clef:latest`)                            | Apache 2.0                                                                                  | Yes               |
| strands-decider (`strands-decider:2b-mlx-bf16`) | Apache 2.0                                                                                  | Yes               |
| gemma4 (`gemma4:31b-mlx`, `gemma4:e4b-mlx`)     | Apache 2.0                                                                                  | Yes               |
| nemotron-3.5-lightning (`:30b-mlx`)             | OpenMDW 1.1 on NVIDIA's own release; the Ollama build ships the NVIDIA Open Model Agreement | Yes, under either |
| granite4.1-guardian (`granite4.1-guardian:8b`)  | Apache 2.0                                                                                  | Yes               |
| qwen3.8 (`qwen3.8:27b-mlx`, optional)           | Apache 2.0                                                                                  | Yes               |
| tev1 (excluded)                                 | None published                                                                              | Unknown           |
| nimble-v3 (excluded)                            | CC BY-NC 4.0                                                                                | No                |

Run `ollama show --license nemotron-3.5-lightning:30b-mlx` to read the Nemotron text you
accepted. Keep that exact tag: the `latest` and `30b` tags carry a stricter licence.

## Guards

Every collected item is untrusted web text. Guards are models that check it before and after
writing. Each guard can be switched off in `digest.config.json`. All are on by default.

```json
"guards": {
  "input":  { "enabled": true, "mode": "any",
              "checks": { "clefPolicy": true, "graniteRisk": true } },
  "output": { "enabled": true, "mode": "any",
              "checks": { "graniteGroundedness": true, "clefRubric": true } }
}
```

| Check                 | Where  | Asks                                                           |
| --------------------- | ------ | -------------------------------------------------------------- |
| `clefPolicy`          | input  | Is the item aimed at an AI system, or harmful?                 |
| `graniteRisk`         | input  | Jailbreak or harm, using Granite Guardian's trained categories |
| `graniteGroundedness` | output | Is each digest item grounded in its source item?               |
| `clefRubric`          | output | Is the draft off-task, hype or harmful?                        |

- `"mode": "any"` blocks on the first flag. `"all"` blocks only when every enabled guard flags.
  `all` gives fewer false blocks and weaker protection.
- A switched-off guard is recorded in `run.json` and named in the digest footer.
- `doctor` warns when any guard is off.
- The **link check** and the **format check** always run, in code. Config cannot turn them off.
  A digest may only contain URLs that were in the collected items.

## Troubleshooting

Start with `doctor`. It prints one line per check (`✓` ok, `!` warning, `✗` error) with a `fix:`
line under each problem, and exits 1 if any check is an error.

```bash
pnpm digest doctor        # Docker: docker compose run --rm digest doctor
```

| Check                        | What it tells you                                                                 |
| ---------------------------- | --------------------------------------------------------------------------------- |
| `config`                     | The config and `.env` load, or which field is wrong                               |
| `ollama`                     | Ollama answers at `OLLAMA_URL`; the version is new enough for the profile         |
| `apple silicon`              | The profile's MLX models can run on this host                                     |
| `model <tag>`                | Each required model is installed (decision models need the `decision` capability) |
| `source <id>`                | Each feed answers within 10 s. A bad feed is a warning: a run skips it            |
| `markdown`, `email`, `slack` | Delivery is set and its secret is present                                         |
| `.env`                       | The file is not readable by other users                                           |
| `guards`                     | Which guards are off                                                              |
| `data dir`                   | The data directory is writable                                                    |

Then look at the runs:

```bash
pnpm digest history -n 4
ls data/runs/                      # one folder per ISO week, for example 2026-W43
cat data/runs/<week>/run.json      # status, timings, models, counts, failed sources, drafts
cat data/runs/<week>/error.json    # only after a failure: step, message, time
```

Failed runs and blocked runs also send a short failure note on every delivery channel, and write
`data/digests/<week>.failed.md`. The steps for each status and alert are in
[`docs/runbook.md`](docs/runbook.md).

## Development

```bash
pnpm install
pnpm check        # typecheck, lint, format check, unit tests
pnpm digest --help
```

Needs Node 24 or later and pnpm. See [`CLAUDE.md`](CLAUDE.md) for the code map and rules.

## License

MIT. The models are licensed separately; see [Model licences](#model-licences).
