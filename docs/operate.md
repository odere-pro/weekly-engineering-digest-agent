# Operate

Set it up, run it, fix it. This page is for the tech lead. How a run works is in
[`how-it-works.md`](how-it-works.md).

Run every command as `pnpm digest <command>` (from source), `node dist/cli.js <command>`
(after `pnpm build`) or `docker compose run --rm digest <command>` (Docker). The global option
`-c, --config <path>` (default `digest.config.json`) goes before the command name.

## Commands

| Command                                                         | What it does                                                                                                  |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `init [-y]`                                                     | Asks for focus areas, profile, time zone and delivery. Writes the config and `.env`                           |
| `doctor [--readiness]`                                          | Checks config, Ollama, models, feeds, delivery, guards, data dir. `--readiness`: verdict per profile          |
| `run [--since Nd] [--dry-run] [--force] [--seed n] [--out dir]` | One full run                                                                                                  |
| `eval [--profile name]`                                         | Replays the eval set and prints a scorecard. `name`: `quality`, `fast`, `light` or `all`                      |
| `fetch [--source id...] [--since Nd] [--out dir]`               | Fetches sources only, no models. Saves raw and parsed data (default `dist/fetch`)                             |
| `show <week> [--part name] [--json]`                            | Prints a saved run. `--part`: `items`, `scores`, `drafts`, `digest`, `run`, `review`. No part: a summary      |
| `preview <week> [--channel name] [--out dir]`                   | Renders the week for `markdown`, `email`, `slack` or `all` into files, sends nothing (default `dist/preview`) |
| `history [-n N]`                                                | Lists past runs: week, status, counts, duration, winner (default 12)                                          |
| `feedback <week>`                                               | Turns the ticks in `data/runs/<week>/review.md` into eval labels                                              |
| `serve`                                                         | Runs the weekly scheduler in the foreground. This is the Compose service                                      |

Options of `run`:

| Option         | Meaning                                                                     |
| -------------- | --------------------------------------------------------------------------- |
| `--since <N>d` | Window in days, `1d` to `31d`. Default `windowDays` (7)                     |
| `--dry-run`    | Writes the digest files. Sends nothing, no failure note                     |
| `--force`      | Runs the week again, even if it has a sent digest                           |
| `--seed <n>`   | Sampling seed for this run. Overrides `models.seed` (default 42)            |
| `--out <dir>`  | Folder for `<week>.md` and `<week>.html`. Overrides `delivery.markdown.dir` |

`init --yes` takes the defaults (profile `light`) and refuses to overwrite a config. `init`
never replaces `.env`: it merges, keeps your keys and comments, and stops if it cannot merge
safely. Without Docker, `init` also prints a launchd, systemd or `schtasks` schedule.

`show` and `preview` read the run folder only. A missing week or part prints a message and exits 1.

### Exit codes

| Code | Meaning                                                                              |
| ---- | ------------------------------------------------------------------------------------ |
| 0    | `sent`, `dry-run` or `skipped`. `doctor` with no errors                              |
| 1    | `failed`: a step error, a held lock, an invalid config. `doctor`: at least one error |
| 2    | `blocked`: every draft was rejected by the checks or guards                          |
| 3    | `quiet`: nothing collected, or fewer than 3 items worth sending                      |

`eval` exits 1 when a hard gate fails. `serve` exits 0 after a stop signal.

## Configuration

`init` writes `digest.config.json` (no secrets) and `.env` (mode 600). Both are git-ignored.
Errors name the field. [`digest.config.example.json`](../digest.config.example.json) shows a
full file with the default sources.

| Key                     | Default                  | Meaning                                                                                                |
| ----------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------ |
| `profile`               | `quality`                | `quality`, `fast` or `light`                                                                           |
| `focusAreas`            | required                 | 1-25 unique topics the classifier sorts items into                                                     |
| `sources`               | required                 | The allowlist. Each has `id`, `kind` (`rss` or `github`), `url`, optional `area`, `maxItems`           |
| `windowDays`            | 7                        | How far back to collect (1-31)                                                                         |
| `maxItemsPerSource`     | 20                       | Newest items kept per source (1-100)                                                                   |
| `topN`                  | 5                        | Items in the digest (3-5)                                                                              |
| `dedupeWeeks`           | 4                        | Weeks of sent URLs removed from new digests (0-12)                                                     |
| `keepWeeks`             | 12                       | Older run folders keep only `digest.md`. At least `dedupeWeeks`                                        |
| `dataDir`               | `data`                   | Runs and the lock                                                                                      |
| `schedule`              | `45 7 * * 1`, local zone | `cron` and `timeZone` for `serve`                                                                      |
| `delivery.markdown.dir` | `dist/digests`           | Where `<week>.md` and `<week>.html` go                                                                 |
| `delivery.email`        | off                      | `host`, `user`, `from`, `to`; `port` 587, `requireTLS` true                                            |
| `delivery.slack`        | off                      | `{ "enabled": true }`                                                                                  |
| `guards`                | all on                   | `input` and `output`: `enabled`, `mode` (`any` or `all`), per-check switches                           |
| `thresholds`            | see below                | `minRelevance` 1.5, `maxHype` 0.6, `maxMinorRelease` 0.75, `guardFlag` 0.35                            |
| `models`                | profile defaults         | `writers`, `timeoutsMs`, `retries` (2), `think`, `seed` (42), `temperature`, `rescoreWithWriter` (off) |

- Guard checks: `clefPolicy`, `graniteRisk` (input); `graniteGroundedness`, `clefRubric`
  (output). `any` blocks on the first flag; `all` blocks only when every guard flags (fewer false
  blocks, weaker protection). The link and format checks have no switch.
- `models.think` sets Ollama thinking per role. `guardRisk` defaults to off, because Granite
  Guardian otherwise spends about a minute per call.
- A GitHub source URL must be exactly `https://github.com/<owner>/<repo>`.

### `.env`

| Variable                             | Meaning                                                                                            |
| ------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `SMTP_PASSWORD`                      | Needed when `delivery.email` is set                                                                |
| `SLACK_WEBHOOK_URL`                  | Needed when Slack is on. Must be `https:`                                                          |
| `GITHUB_TOKEN`                       | Optional. Higher rate limits; switches GitHub sources to the REST API                              |
| `OLLAMA_URL`                         | Default `http://localhost:11434`. In Docker never `localhost`                                      |
| `LOG_LEVEL`                          | `debug`, `info` (default), `warn`, `error`                                                         |
| `OTEL_EXPORTER_OTLP_ENDPOINT`        | Set to turn on OpenTelemetry traces                                                                |
| `DIGEST_HOST_OS`, `DIGEST_HOST_ARCH` | OS and CPU of the machine that runs Ollama, when the app runs elsewhere. `make docker-*` sets them |
| `EVAL_JUDGE`                         | Model tag `digest eval` uses to score digests of a profile with no judge                           |
| `TZ`, `DIGEST_UID`, `DIGEST_GID`     | Docker only                                                                                        |

The process environment wins over `.env`. An unquoted value ends at its first `#`:
`SMTP_PASSWORD=pa#ss` is read as `pa`. Quote it. `doctor` warns about this and about a `.env`
that other users can read (`chmod 600 .env`).

## First-run checklist

1. Hardware matches your profile ([README](../README.md#cost-and-hardware)).
2. `node --version` is 24 or newer. For Docker, `docker compose version` is 2.24 or newer.
3. Ollama is installed (0.40.0 or newer; 0.35.1 for the fallback set). On a host Ollama set
   `OLLAMA_MAX_LOADED_MODELS=1` and restart it.
4. `pnpm install --frozen-lockfile`.
5. Pull each model of your profile with `ollama pull <tag>`; `ollama list` shows them.
6. `pnpm digest init` (Docker on a Mac: `make docker-init`).
7. `pnpm digest doctor`. Every line must be `✓` or an accepted `!`. Fix every `✗`.
8. `pnpm digest run --dry-run`. It writes the digest and exits 0. Do not schedule weekly runs
   before this works.

Network: the feed hosts in [`sources.md`](sources.md), `api.github.com` (with a token), your
Ollama, and the SMTP host or Slack webhook you configure. Nothing else is called.

Docker on a Mac: Ollama runs on the host and `OLLAMA_URL` must be
`http://host.docker.internal:11434` (`init` sets it). On Linux, leave it unset and Compose uses
its own `ollama` service; add `gpus: all` in `docker-compose.yml` for an NVIDIA GPU.
`REFRESH_MODELS=1` pulls models that are already present.

## Status to action

Start here after any run that did not end `sent`:

1. `digest history -n 4`. The newest row is the run to look at.
2. `digest show <week>` for the summary, or open `data/runs/<week>/run.json`. After a failure
   also open `error.json`.
3. `digest doctor`. It prints a `fix:` line for each problem.
4. Logs are JSON on stdout (`docker compose logs digest`). Filter by `runId` for one week and
   `step` for one step. `LOG_LEVEL=debug` adds detail.

Failed and blocked runs send a short failure note on every channel and write
`<week>.failed.md`. A dry run sends none.

| Status    | Do this                                                                        |
| --------- | ------------------------------------------------------------------------------ |
| `failed`  | Read the step in the note or `error.json`; see below. Fix the cause, run again |
| `blocked` | Read `digest show <week> --part drafts`. See the check table below. Run again  |
| `quiet`   | Often normal. Check `counts` in `run.json`; see below                          |
| `skipped` | The week already has a sent digest. `digest run --force` to send again         |

### Failed

| Step or message                                            | Cause and fix                                                                                                                                                                          |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Ollama is not reachable` / `missing models`               | Start Ollama or fix `OLLAMA_URL`. Run the `ollama pull` lines `doctor` prints                                                                                                          |
| `guardInput`, `classify`, `write`, `guardOutput`, `select` | A model call failed (timeout, missing model, bad output after one repair). Calls retry twice. Run `doctor`, check memory, raise `models.timeoutsMs`, for example `{ "write": 900000 }` |
| `write`, every writer failed                               | Reasons are in `drafts.json` under `failures`. One failing writer does not fail the run                                                                                                |
| `deliver`                                                  | At least one channel failed. `deliveredTo` in `run.json` lists the ones that got it. See below                                                                                         |
| `Run aborted before the <step> step`                       | `serve` hit its 3 h limit or got a second stop signal. The next start catches the week up                                                                                              |
| `Another run is in progress`                               | The lock is held. See Lock                                                                                                                                                             |
| Invalid config or `Invalid --since`                        | Fix the named field                                                                                                                                                                    |
| `Could not save the run record`                            | The data dir is not writable or the disk is full                                                                                                                                       |

**Delivery.** Check `doctor` (`email` needs `SMTP_PASSWORD`, `slack` needs `SLACK_WEBHOOK_URL`),
the SMTP host, port and TLS settings, and the webhook. The winner is in
`data/runs/<week>/digest.md` if you need to send it by hand. `digest run` does not start over:
it sends the saved `digest.md` to the channels that missed it and marks the week `sent`. Use
`--force` only when every channel may get a second digest.

### Blocked

Every draft was rejected. The note and `run.json` name each writer and the check ids.

| Check id              | Meaning                                                            | What to do                                                                      |
| --------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `write`               | A writer made no usable draft while another draft was rejected     | Check the model and its timeout                                                 |
| `linkCheck`           | A URL is not a collected one, or has no `https://` scheme          | Never turn it off. Run again; if it repeats, read `rejections` in `drafts.json` |
| `formatCheck`         | Wrong item count, a missing part, an em dash, or 500 words or more | Run again; if it repeats, change `models.writers`                               |
| `graniteGroundedness` | A summary, headline or intro is not backed by its sources          | Run again; if it repeats on one writer, replace that writer                     |
| `clefRubric`          | The draft was off-task, hype or harmful                            | Run again; read the draft in `drafts.json`                                      |

If a guard blocks good drafts week after week, read the draft before switching the guard off.
`mode: "all"` blocks less and protects less.

### Quiet

| Situation                        | Check                                                                                                     |
| -------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `collected` is 0 and a note came | Every feed failed or the window was empty. See `failedSources` and the `source` lines of `doctor`         |
| `collected` above 0, no note     | Items were dropped as sent, duplicate, low relevance, hype, minor, or by the input guards. A valid result |
| Quiet again and again            | Try `run --since 14d`. Check `focusAreas` against the sources and `counts.afterGuardInput`                |

## Operations

**Lock.** One run per `dataDir`, in `data/digest.lock`. If a run is going, wait. If none is,
do nothing: the next run takes over a stale lock (process gone, or no heartbeat for 5 minutes).
If it still refuses, stop everything that uses this `data/` and delete the file. A run that
hangs but stays alive keeps its lock; restart it (`docker compose restart digest`). Keep `data/`
on a local disk that supports hard links.

**Scheduler.** `serve` runs the cron in `schedule.cron` (Monday 07:45) in `schedule.timeZone`.
At start it catches up: it runs the current week if it has no run, or its last run `failed` or
was a `dry-run`. It leaves `sent`, `quiet` and `blocked` weeks alone. If the lock is held it
retries every 5 minutes for up to 2 hours. A `failed` run is retried at most twice, 30 minutes
apart, unless it hit its time limit or needs `--force`. A week sends one failure note, from its
last attempt. The log line `Scheduler started` shows the cron and `nextRun`. A host timer
(launchd, systemd, `schtasks`) uses the machine's local time, not `schedule.timeZone`.
Not running? `docker compose ps` must show `digest` up; start it with `docker compose up -d`
(Linux: add `--profile linux`).

**Stopping.** `docker compose stop` waits up to 90 minutes for a running digest
(`stop_grace_period`). A second stop signal stops the digest after its current step; a third
ends the process. If you stop while a failed week waits for its retry, the held note is sent at
once and the next start runs the week again.

**Slow model or out of memory.** Use a smaller profile (`fast`, `light`) or one writer in
`models.writers`. Keep `OLLAMA_MAX_LOADED_MODELS=1`. Guards run one call at a time because
Ollama serves them one after another anyway.

**Delivery retries.** An email or Slack send is retried twice (after 5 and 10 s), only when
nothing was sent: a connect failure, an HTTP 429 or 5xx, or an SMTP 421, 450 or 451. Any other
error fails the channel at once. A message can still arrive twice after a reset or timeout.

**Feeds.** A failing feed is skipped and listed in `failedSources`. `doctor` shows one
`source` line per feed. Fix the URL or remove the source. Add `GITHUB_TOKEN` for GitHub rate
limits; a rate-limited source is not retried. A feed that redirects to another host or sends
more than 5 MiB fails its source.

**Disk.** Folders older than `keepWeeks` keep only `digest.md`. Delete older
`data/runs/<week>` folders by hand if you need space, but keep at least `dedupeWeeks` weeks or
the digest may repeat items.

**Tracing.** Set `OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318/v1/traces` in `.env`, then
`docker compose --profile tracing up -d`. Jaeger is on `http://localhost:16686`.

**Eval.** `digest eval` replays the recorded weeks and writes
`evals/scorecards/<date>-<profile>.json`. Set `EVAL_JUDGE` to score profiles with no judge. It
checks first that Ollama lists the tag as a decision model, and exits 1 if not. It never pulls.

## Debugging a week

1. `digest fetch --source <id> --since 7d` shows what a feed returned, with no models. Raw and
   parsed data land in `dist/fetch`.
2. `digest show <week>` summarises the run. `--part items` shows what was collected,
   `--part scores` why items were kept or dropped, `--part drafts` what each writer made and why a
   draft was rejected.
3. `digest preview <week>` renders the week for each channel into `dist/preview/<week>/`
   (`digest.md`, `email.html`, `email.txt`, `slack.json`) without sending.
4. Logs: filter by `runId` and `step`.

Before you change a prompt, a threshold or a model, keep the `data/runs/<week>/` folder of a bad
week. It is the raw material for a new eval case.
