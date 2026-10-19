# Changelog

All notable changes to this project are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Digest items carry an urgency (Act now, Worth a look, Good to know) and a one-line action.
  The Markdown is a table per urgency group under the title "Week <id>: <n> releases, <k> need
  action".
- Every run also writes `<week>.html`. Email goes out as HTML and plain text; Slack as Block Kit.
- Everything the project produces goes under `dist/` (the `dataDir` default, was `data`):
  `dist/artifacts/` for the build, `dist/<monday>/digest/` for a week's run and its digest files,
  `dist/<day>/<source>/raw/` and `formatted/` for what each source answered and the items read
  from it, and `dist/logs/<day>/digest.log` for the logs. `run --out <dir>` still picks another
  digest folder; a dry run writes the files too. Docker mounts `./dist`. Old `data/runs/`
  folders are not read.
- `digest fetch`: fetch the sources only and save raw and parsed data into the day's source
  folders, as a run does.
- `digest show <week>` and `digest preview <week>`: inspect a saved run and render it for each
  channel without sending.
- `digest doctor --readiness`: a verdict per profile for this machine.
- `run --seed` and the `models.seed` and `models.temperature` keys. A rerun of a week repeats
  itself.
- `models.rescoreWithWriter` (off by default): the writer model scores the items at or above
  `thresholds.minRelevance` a second time. It takes effect in `digest run` and `digest eval`.
- Each writer gets one retry when every draft fails the link or format check.
- Email and Slack sends are retried twice, but only when nothing was sent.
- A week that fails in `serve` is retried at most twice and sends one failure note.
- The groundedness guard checks the headline and intro against the cited sources.
- New `doctor` checks: data dir, markdown folder, Ollama development builds, `.env` values cut
  at a `#`, and the heavy fallback of `light` off a Mac.
- `digest eval` scores digests with `EVAL_JUDGE` and names the attack cases that got through.
- `factCarry` eval metric: every version, CVE or GHSA id and date in a shipped digest must be
  in its own source item. Each miss names the checks and guards it got past. Soft gate for now.
- `pnpm docs:mermaid` parses every Mermaid block in tracked Markdown; `pnpm check` and CI run it.
- `digest init` shows "Save locally" with this week's digest folder as the first, preselected
  delivery choice. It cannot be unticked: local files are always written.

### Changed

- The run's abort (the time limit, or stopping `digest serve`) now stops the collect step and the
  guards within one call. A step that was running fails as `Run aborted during the <step> step`
  and is not retried. Classify, write and select now stop within one model call too: no new call
  or writer starts after the abort, and an aborted writer or judge is not a failed writer or a
  fallback winner.
- `evals/calibrate.ts --write` saves to `<dataDir>/eval/calibration/<profile>.json`, no longer
  into the code folder `evals/calibration/`.
- The `commit-msg` hook rejects a subject over 72 characters.
- `digest init` recommends `light` and merges into an existing `.env`. The schema default is
  still `quality`.
- `SLACK_WEBHOOK_URL` must be `https:`. A source URL with a username or password is rejected.
- Feeds follow redirects only to their own host and refuse bodies over 5 MiB. Dates without a
  zone are read as UTC; 408 and 429 are retried.
- The scheduler retries a held lock every 5 minutes for up to 2 hours. `stop_grace_period` is
  90 minutes.
- Secrets are redacted again just before a record is saved or a message is sent, including the
  digest view.
- Two items about the same release from different sources are merged.
- A `models.writers` list with a writer from the judge's model family fails at config load.
  `clef` counts as Qwen.
- `pnpm pack` and `pnpm publish` build `dist/artifacts/cli.js` first (`prepack`).

### Fixed

- The eval scorecard printer replaced only a hand-listed set of invisible characters; U+061C,
  U+2060-2064, U+206A-206F, U+FEFF and U+00AD got through. It now replaces every control and
  format character.
- The link check no longer rejects a valid URL with `www.` in it. This left one recorded week
  without a digest.
- A bare `www.host/path` link that names a collected item gets `https://` instead of a reject.
- The groundedness guard no longer flags clean headlines and intros.
- Google Cloud release notes are no longer collapsed into one item.
- One bad feed entry no longer fails its source. Hostile markup no longer stalls a run.
- A week that was only partly delivered is deduped the next week.
- A dry or forced run can no longer replace a `digest.md` that a channel already has.
- A scheduler tick that met a held lock is no longer dropped.

### Known limits

- Only `light` has a baseline: format (83%) and attack handling (90%) are red. It has not been
  re-run since the fixes above. `quality` and `fast` are not measured.
- The link check ignores autolinks with a scheme other than `http(s)` and accepts a collected
  URL with extra tracking parameters.

### Removed

- Mastra is gone (ADR 0001): a plain loop runs the steps. 124 fewer packages and a faster CLI start.

## [0.1.0] - 2026-10-17

First release. A local-first CLI agent that reads allowlisted RSS/Atom feeds and GitHub
releases, then writes a weekly Markdown digest of the 3-5 releases that matter. Every model
call runs on Ollama; nothing leaves the machine unless you turn on Slack or email delivery.

### Added

- **Collect:** RSS/Atom and GitHub releases fetchers with a verified default source allowlist,
  per-source timeout, retries and cross-week dedupe.
- **Pipeline:** guard-input, classify, process (filter, dedupe, rank, top N), write (a panel of
  writers), guard-output, select (a judge scores each draft) and deliver, as plain async steps
  wrapped in a Mastra workflow.
- **Guards:** Granite Guardian risk and groundedness checks and the clef policy guard, in
  `any` or `all` mode. The link check and the format check are always on.
- **Models:** an Ollama provider with `generate`, `decide` (systemone) and health checks;
  per-role model profiles (`light`, `quality`, `fast`) picked from the host OS and CPU; per-role
  thinking control, off by default for guards.
- **Delivery:** Markdown file, Slack webhook and SMTP (STARTTLS required by default), recorded
  per channel so a rerun resumes only the channels that missed the digest.
- **Store:** a filesystem run store with run folders, a heartbeat lock, idempotency and pruning.
- **CLI:** `init` (interactive setup, prints an OS schedule), `doctor`, `run` (with
  `--dry-run`), `history`, `eval` and `serve` (weekly scheduler with missed-week catch-up).
- **Config:** JSON config plus `.env`, zod-validated with readable errors; secrets never reach
  logs, run records or traces.
- **Observability:** a redacting pino logger and optional OpenTelemetry tracing (Jaeger profile
  in Compose).
- **Docker:** a non-root image and Compose files for a Mac (host Ollama) and Linux (bundled
  Ollama, optional GPU), with `make docker-init` and `make docker-up`.
- **Evals:** case schemas, metrics and a scorecard; 6 recorded and labeled weeks, 60 labeled
  classifier cases, 10 prompt-injection attacks and 10 grounding cases; a threshold sweep that
  tuned the light profile.
- **Docs:** README with install, commands, configuration and licences; a runbook; the system
  design; source and licence tables; a v1.0 tracker for four unattended Mondays.

### Known limits

- Only the `light` profile has a baseline. `quality` and `fast` are not measured; they need better
  hardware than the reference laptop. The thresholds were tuned on `light` only, and they apply to
  every profile.
- The format hard gate is red on `light`: 4 of 6 replayed weeks (67%) produced a digest that
  passed. In 2026-W39 the only draft failed the link check, and the cause was not recorded. The
  other three hard gates pass. `v0.1.0` is tagged with this gate red.
- The package is not published to npm or GHCR yet; install from a clone.
- Judge calibration against hand-graded digests is still open.

[Unreleased]: https://github.com/odere-pro/weekly-engineering-digest-agent/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/odere-pro/weekly-engineering-digest-agent/releases/tag/v0.1.0
