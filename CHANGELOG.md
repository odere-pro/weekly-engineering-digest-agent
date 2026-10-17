# Changelog

All notable changes to this project are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

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

- Only the `light` profile is measured. `quality` and `fast` need better hardware than the
  reference laptop.
- The package is not published to npm or GHCR yet; install from a clone.
- Judge calibration against hand-graded digests is still open.

[0.1.0]: https://github.com/odere-pro/weekly-engineering-digest-agent/releases/tag/v0.1.0
