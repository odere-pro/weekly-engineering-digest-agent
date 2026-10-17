# Engineering Digest Agent

A local-first agent that writes a weekly digest of the 3-5 AI and platform engineering
releases that matter. It runs end to end on [Ollama](https://ollama.com) at zero cost.

Once a week it reads a list of RSS/Atom feeds and GitHub releases, checks the text with
guards, picks the items that matter, writes the digest with a panel of models, checks the
result, and delivers it as Markdown, email or Slack.

> Status: v0.1.0 plus the fixes listed under "Unreleased" in [`CHANGELOG.md`](CHANGELOG.md). Only
> the `light` profile has a baseline, and two of its hard gates are red: format and attack
> handling (see [Profiles](#profiles)). The package is not published to npm; install from a clone.

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
of RAM, but only on a Mac with Apple silicon. On any other machine it uses larger models and needs
much more. See [Profiles](#profiles).

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
passed, it catches up: it runs the week at once when the week has no run, or its last run
`failed` or was a `dry-run`. It leaves a week that is `sent`, `quiet` or `blocked` alone. When a
tick finds the run lock held, for example by a manual `digest run`, it tries again every 5
minutes for up to 2 hours. A run that ends `failed` is tried again at most twice, 30 minutes
apart, unless it hit its time limit or only `digest run --force` can finish the week. A run may
take 3 hours; then it is stopped after its current step and ends `failed`. On stop it waits for a
running digest to finish (up to 90 minutes in Compose). A second stop signal (Ctrl-C twice)
stops the digest after its current step, and a third ends the process.

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
| `--force`      | Runs the whole week again, even if it has a sent digest                  |

A plain `digest run` of a week that is only partly delivered (the run `failed` after some
channels got the digest) does not start over. It sends the saved `digest.md` to the channels that
missed it, with no model call, and then marks the week `sent`. It refuses if `digest.md` is gone
or no longer matches what the other channels got; `--force` then sends a new digest to every
channel. A forced or dry run that reaches no channel leaves the record and files of a week that
was already sent or partly delivered as they were. `digest run` then prints no Digest line; its
last line says why, for example "Kept the sent run record; this forced run did not end sent. The
week's run folder is unchanged."

Email and Slack sends that fail with a network error, a timeout or a 5xx answer are tried again
twice (after 5 and 10 seconds). A retry can deliver a message twice when only the answer was lost.

`init --yes` accepts the defaults without asking and recommends the `light` profile. It refuses to
overwrite an existing config (exit 1). Without `--yes`, `init` asks before it overwrites the
config. An existing `.env` is never replaced: `init` merges into it. It keeps your other keys and
comments, keeps an `OLLAMA_URL` you set by hand, and replaces only the secrets you give it. If the
file cannot be merged safely, such as a value that spans lines, `init` stops and writes nothing.

### Exit codes

| Code | Meaning                                                                             |
| ---- | ----------------------------------------------------------------------------------- |
| 0    | Success: `sent`, `dry-run` or `skipped`. Also the result of `doctor` with no errors |
| 1    | Failed: a step error, a held lock, an invalid config. `doctor`: at least one error  |
| 2    | Blocked: every draft was rejected by the checks or guards                           |
| 3    | Quiet week: no items collected, or fewer than 3 items worth sending                 |

`digest eval` exits 1 when a hard gate fails, otherwise 0. It prints the weeks with problems and
the item ids of each stability run, and writes `evals/scorecards/<date>-<profile>.json` (a second
run on the same day overwrites it). To score the winning digests of a profile that has no judge,
set `EVAL_JUDGE=<model tag>` in the shell, for example
`EVAL_JUDGE=clef:latest pnpm digest eval --profile light`. `EVAL_JUDGE` is read from the shell
only: a value in `.env` is ignored, because the environment schema drops keys it does not know. A
typo in the tag shows only after the replay, so check it with `ollama list` first. `digest history`
exits 0, or 1 on a config error. `digest serve` exits 0 after a stop signal.

### Run statuses

`digest run` prints the week, status, item counts, winner, duration, failed sources and rejected
drafts. The same data is in `data/runs/<week>/run.json`.

| Status    | Meaning                                                     | Exit |
| --------- | ----------------------------------------------------------- | ---- |
| `sent`    | The winning digest reached every channel                    | 0    |
| `dry-run` | `--dry-run` and a winner was picked; nothing was sent       | 0    |
| `skipped` | The week already has a sent digest and `--force` is not set | 0    |
| `quiet`   | No items collected, or fewer than 3 selected                | 3    |
| `blocked` | Drafts were written, and every one was rejected             | 2    |
| `failed`  | A health check, a step or a delivery failed, or no draft    | 1    |

`failed` covers a run where every writer failed (step `write`). `blocked` means at least one
draft exists and the checks or guards rejected all of them. A delivery that reaches only some
channels is `failed`; `deliveredTo` in `data/runs/<week>/run.json` says which.

## Configuration

`digest init` writes two files in the working directory. Both are ignored by git.

- `digest.config.json` holds everything except secrets. It is validated at startup, and an
  error names the field. [`digest.config.example.json`](digest.config.example.json) shows a full
  file with the default sources.
- `.env` holds secrets and environment settings. `init` writes it with mode 600.

Recipients, webhooks and endpoints come from these two files only, never from model output.

### `digest.config.json`

| Field               | Default                  | Meaning                                                                                                  |
| ------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------- |
| `profile`           | `quality`                | `quality`, `fast` or `light`                                                                             |
| `focusAreas`        | required                 | 1-25 unique topics the classifier sorts items into                                                       |
| `sources`           | required                 | The allowlist of feeds. Each has `id`, `kind` (`rss` or `github`), `url`, optional `area` and `maxItems` |
| `windowDays`        | 7                        | How far back to collect (1-31)                                                                           |
| `maxItemsPerSource` | 20                       | Newest items kept per source (1-100)                                                                     |
| `topN`              | 5                        | Items in the digest (3-5)                                                                                |
| `dedupeWeeks`       | 4                        | Weeks of already sent URLs removed from new digests (0-12)                                               |
| `keepWeeks`         | 12                       | Run folders older than this keep only `digest.md`. Must be at least `dedupeWeeks`                        |
| `dataDir`           | `data`                   | Where runs and the lock live                                                                             |
| `schedule`          | `45 7 * * 1`, local zone | `cron` and `timeZone` for `serve`                                                                        |
| `delivery`          | Markdown only            | `markdown.dir` (default `data/digests`), optional `email`, optional `slack`                              |
| `guards`            | all on                   | See [Guards](#guards)                                                                                    |
| `thresholds`        | see below                | Cut-offs applied after classification                                                                    |
| `models`            | profile defaults         | `writers`, `timeoutsMs`, `retries` (default 2), `think`                                                  |

Thresholds: `minRelevance` 1.5 (0-3), `maxHype` 0.6, `maxMinorRelease` 0.75, `guardFlag` 0.35. These are the light-profile defaults from the threshold sweep (`evals/thresholds/README.md`).

`models.writers` replaces the writer panel. One entry turns the panel and the judge off.

`models.think` sets Ollama thinking per role (`true`, `false`, `"low"`, `"medium"` or `"high"`).
It applies to `guardRisk` and `write`, the roles that chat with a model. Without a setting,
`guardRisk` has thinking off, because Granite Guardian otherwise spends about a minute on
reasoning per call, and the other roles keep the model's own default. `digest doctor` shows the
value each role gets.

Email needs `delivery.email` with `host`, `user`, `from` and `to`; `port` defaults to 587 and
`requireTLS` to `true`. Slack needs `delivery.slack = { "enabled": true }`.

Sources are listed in [`docs/sources.md`](docs/sources.md). A GitHub source URL must be exactly
`https://github.com/<owner>/<repo>`. A source URL may not contain a username or password. `area` is
a hint: a run passes it to the classifier as a line `Source tag: <area>`, and the classifier still
picks each item's area itself, from your `focusAreas`.

### `.env`

| Variable                             | Meaning                                                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `SMTP_PASSWORD`                      | Needed when `delivery.email` is set                                                                                            |
| `SLACK_WEBHOOK_URL`                  | Needed when `delivery.slack.enabled` is true. Must be an `https:` URL; `http:` is rejected when the config loads               |
| `GITHUB_TOKEN`                       | Optional. Higher GitHub rate limits; uses the REST API instead of the Atom feed                                                |
| `OLLAMA_URL`                         | Default `http://localhost:11434`. `init` sets it for Docker on a Mac. In Docker never use `localhost`                          |
| `LOG_LEVEL`                          | `debug`, `info` (default), `warn` or `error`                                                                                   |
| `OTEL_EXPORTER_OTLP_ENDPOINT`        | Set it to turn on OpenTelemetry traces                                                                                         |
| `DIGEST_HOST_OS`, `DIGEST_HOST_ARCH` | The OS and CPU of the machine that runs Ollama, when the app runs in a container on a different one. `make docker-*` sets them |
| `TZ`, `DIGEST_UID`, `DIGEST_GID`     | Docker only. Time zone of the container, and the user the container runs as                                                    |

Values from the process environment win over `.env`. Secrets never reach logs, run records,
traces or delivered messages: each is taken out again just before a record is saved or a message
is sent. `doctor` warns when `.env` is readable by other users (`chmod 600 .env` fixes it).

An unquoted value in `.env` ends at its first `#`: `SMTP_PASSWORD=pa#ss` is read as `pa`, with no
error. Put such a value in quotes, for example `SMTP_PASSWORD="pa#ss"`. `doctor` warns about an
unquoted `#` and names the key and the line, never the value.

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

| Profile   | Classify and policy guard     | Risk guard               | Writers                                            | Judge         | Memory                                  | Speed                             | Quality                                                                                  |
| --------- | ----------------------------- | ------------------------ | -------------------------------------------------- | ------------- | --------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------- |
| `quality` | `clef:latest`                 | `granite4.1-guardian:8b` | `gemma4:31b-mlx`, `nemotron-3.5-lightning:30b-mlx` | `clef:latest` | about 32 GB RAM, 40 GB disk             | not measured yet                  | not measured yet                                                                         |
| `fast`    | `strands-decider:2b-mlx-bf16` | `granite4.1-guardian:8b` | `nemotron-3.5-lightning:30b-mlx`                   | none          | not measured yet                        | not measured yet                  | not measured yet                                                                         |
| `light`   | `strands-decider:2b-mlx-bf16` | `granite4.1-guardian:8b` | `gemma4:e4b-mlx`                                   | none          | fits in 16 GB RAM on Apple silicon only | 320 s per replayed week (average) | 2 of 4 hard gates pass; format (83%) and attack handling (90%) are red; false blocks 50% |

- Only `light` has a baseline: `digest eval --profile light` on 2026-10-17, after the wave 5
  fixes (`evals/scorecards/2026-10-17-light-wave5.json`; the v0.1.0 scorecard
  `2026-10-17-light.json` stays for comparison). Two of the four hard gates are red. Format passes
  in 5 of 6 replayed weeks (83%, was 67%): in 2026-W39 the writer repeats a link without a scheme
  in both attempts, so the retry does not help. Attack handling is 90% (was 100%): one attack
  item that no guard flagged reached a digest. The guards flag 6 of 10 attacks. The groundedness
  guard flags 5 of 10 clean control drafts (false blocks 50%, was 0%), probably because of its
  new headline and intro check. A fix for the format and groundedness regressions is planned. The
  gates and how to read them are in [`docs/profiles.md`](docs/profiles.md).
- `quality` and `fast` are not measured. They need better hardware than the reference laptop, and
  the thresholds were tuned on `light` only.
- The memory figures for `quality` and `light` are the sizes `digest init` shows.
- The `quality` profile writes with both models and the judge picks the better draft. If the
  judge fails or gives an unusable answer, the first passing draft in writer order wins, with a
  warning in the log and no scores. The other two profiles have one writer, so there is no judge
  step.
- Steps run one after another, so one model is in memory at a time. Set
  `OLLAMA_MAX_LOADED_MODELS=1` on a host Ollama.
- The MLX tags and `strands-decider` need an Apple silicon Mac and Ollama 0.40.0 or newer. On any
  other machine every profile falls back to the untuned set: `clef:latest`,
  `granite4.1-guardian:8b` and `gemma4:31b`, with no judge (Ollama 0.35.1 or newer). That includes
  `light`: off a Mac with Apple silicon it needs much more than 16 GB, and `digest doctor` and
  `digest init` say so.
- `init` recommends `light`, and `init --yes` writes it, because `quality` has no baseline yet: one
  run took about 1 hour on the reference laptop. The default in the config schema is still
  `quality`, so set `profile` yourself if you write the config by hand.

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

| Check                 | Where  | Asks                                                                                                                      |
| --------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------- |
| `clefPolicy`          | input  | Is the item aimed at an AI system, or harmful?                                                                            |
| `graniteRisk`         | input  | Jailbreak or harm, using Granite Guardian's trained categories                                                            |
| `graniteGroundedness` | output | Is each digest item grounded in its source item, and are the headline and intro grounded in the sources the digest cites? |
| `clefRubric`          | output | Is the draft off-task, hype or harmful?                                                                                   |

- `"mode": "any"` blocks on the first flag. `"all"` blocks only when every enabled guard flags.
  `all` gives fewer false blocks and weaker protection.
- A switched-off guard is recorded in `run.json` and named in the digest footer.
- `doctor` warns when any guard is off.
- The **link check** and the **format check** always run, in code. Config cannot turn them off.
  A digest may only contain URLs that were in the collected items.
- When every draft fails those two checks, each writer gets one retry. The prompt lists the
  problems the checks found, as untrusted data with any URL in them masked. The problems are in
  the log and in `data/runs/<week>/drafts.json` (`rejections`), never in the run record or the
  failure note.
- An item title is not checked by the groundedness guard. It checks each summary, the "why it
  matters" line, the headline and the intro.

## Troubleshooting

Start with `doctor`. It prints one line per check (`✓` ok, `!` warning, `✗` error) with a `fix:`
line under each problem, and exits 1 if any check is an error.

```bash
pnpm digest doctor        # Docker: docker compose run --rm digest doctor
```

| Check                        | What it tells you                                                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `config`                     | The config and `.env` load, or which field is wrong                                                                                     |
| `ollama`                     | Ollama answers at `OLLAMA_URL`                                                                                                          |
| `ollama version`             | The version is new enough for the profile. A development build (`0.0.0`) or a pre-release of the minimum is a warning                   |
| `apple silicon`              | The profile's MLX models can run on this host. For `light` off a Mac, a warning says it falls back to the heavy models                  |
| `model <tag>`                | Each model the run uses is installed (decision models need the `decision` capability). The model of a guard that is off is not required |
| `think`                      | The thinking setting each role sends to Ollama                                                                                          |
| `source <id>`                | Each feed answers within 10 s. A bad feed is a warning: a run skips it                                                                  |
| `markdown`, `email`, `slack` | Delivery is set and its secret is present. `markdown` also checks that the folder is writable                                           |
| `.env`                       | The file is not readable by other users                                                                                                 |
| `.env values`                | No unquoted value contains a `#`, which would cut it short                                                                              |
| `guards`                     | Which guards are off                                                                                                                    |
| `data dir`                   | The data directory is writable. A file or a dangling symlink there is an error                                                          |

Then look at the runs:

```bash
pnpm digest history -n 4
ls data/runs/                      # one folder per ISO week, for example 2026-W43
cat data/runs/<week>/run.json      # status, timings, models, counts, failed sources, drafts
cat data/runs/<week>/error.json    # only after a failure: step, message, time
cat data/runs/<week>/drafts.json   # drafts, failed writers, and why the checks rejected a draft
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
