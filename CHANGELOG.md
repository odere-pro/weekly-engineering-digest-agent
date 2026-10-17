# Changelog

All notable changes to this project are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

Wave 5: fixes for the findings of the v0.1.0 review. The `v0.1.0` tag is not moved; everything
below comes after it.

### Added

- **Writer retry:** when every draft fails the link or format check, each writer gets one retry
  with the problems listed. The problems are logged and stored in `drafts.json` (`rejections`),
  never in the run record or the failure note.
- **Abort:** `RunOptions.signal`. A run whose caller aborts it ends `failed` with
  `Run aborted before the <step> step` and releases the lock. `digest serve` sets it for a run
  time limit of 3 hours and for a second stop signal; `digest run` sets none.
- **Scheduler:** a scheduled or catch-up run that ends `failed` is tried again at most twice,
  30 minutes apart. A run that hit its time limit, or that only `digest run --force` can finish,
  is not tried again.
- **Delivery retry:** an email or Slack send that fails with a network error, a timeout or a 5xx
  answer is tried again twice (after 5 and 10 seconds).
- **Traces:** one `model.generate` or `model.decide` span per model call, with a `model.usage`
  span inside it (role, model, latency, tokens). No prompt or answer text.
- **Forced runs:** `digest run` says why a forced run kept the week's record and folder. The
  reason is `RunResult.kept`, and the command prints it as its last line.
- **Doctor checks:** a `dataDir` that is a file or a dangling symlink, a `markdown.dir` that is
  not writable, a development build or a pre-release of the minimum Ollama version, an unquoted
  `.env` value cut at a `#`, and a warning that `light` off a Mac uses the heavy fallback.
- **Groundedness:** the Granite guard also checks the headline and intro against the sources the
  digest cites.
- **Logs:** a warning when a source yields no usable item, and a `questionChars` field in the
  `decide state trimmed` warning.
- **CI:** an `image-scan` job (Trivy 0.75.0, pinned by digest, fails on HIGH and CRITICAL). It has
  not run yet.
- **Evals:** per-week detail (`byWeek`) on the format and link metrics, the item ids of every
  stability run, a `guardAttackRecall` metric (soft gate, 90%), an optional eval judge for
  profiles without one, and `evals/judge/` with a grading sheet and a calibration check.
- **Eval judge:** `digest eval` scores the winning digests of a profile that has no judge when
  `EVAL_JUDGE` names a model in the shell. `.env` is ignored for it, because the environment
  schema drops keys it does not know. It has not run against a real judge yet. `digest eval` also prints the weeks with problems and the item ids of each stability
  run.
- **Light scorecard after wave 5:** `evals/scorecards/2026-10-17-light-wave5.json`, next to the
  v0.1.0 one. The hard gates are still red: format 83% (was 67%) and attack handling 90% (was
  100%). Guard false blocks are 50% (was 0%), probably from the new headline and intro check.
- **Adapter pipeline:** every source goes through one pipeline, and an `rss` entry with no text
  in the feed gets the first paragraphs of its own page (same host only, 4 seconds per source).
  Summary text comes from `content:encoded`, then `content`, `summary` and `description`.
  `pnpm tsx evals/recordSources.ts --pages` records the pages.
- **Source evals:** the real response of each default source is recorded in `evals/sources/`
  (`pnpm tsx evals/recordSources.ts`), with a hand-checked list of the items it must yield. Two
  soft metrics, `sourceParse` (95%) and `sourceSummaryFill` (90%), check the fetchers against it.
- **Threshold sweep:** it picks on a training split and also scores a held-out one, and warns when
  the two differ by more than 0.1.
- **Classifier source tag:** a run passes each source's `area` to the classifier as a line
  `Source tag: <area>`. It is a hint: the classifier still picks the area itself, from your focus
  areas. Its effect is not measured yet.
- **Internals:** `FetchError`, `modelsInUse`, `LoadedConfig.platform`, `effectiveThink`, and
  `counts.afterProcess` in the run record (filled by the run).

### Changed

- **Profiles:** `digest init` recommends `light` until `quality` has a baseline, and says that
  `quality` took about 1 hour per run. The schema default is still `quality`.
- **`init` and `.env`:** `init` merges into an existing `.env` and keeps your other keys and an
  `OLLAMA_URL` you set. The RAM check has a 5% tolerance and names the Docker container limit.
  `init --yes` refuses only an existing config.
- **Slack:** `SLACK_WEBHOOK_URL` must be an `https:` URL.
- **Feeds:** a fetch follows a redirect only to the source's own host and refuses a body over
  5 MiB. Atom links use `rel="alternate"` and lose tracking parameters. `published` wins over
  `updated`, and a date with no zone is read as UTC. Summaries drop `<script>` text and keep
  `Vec<T>`. A 408 or 429 is retried. Error text in the run record is cut to 300 characters.
- **Config:** a source URL with a username or password is rejected when the config loads.
- **Run semantics:** a dry or forced run that reaches no channel leaves the record and files of a
  week that was already sent or partly delivered as they were.
- **Scheduler:** a tick or catch-up that finds the run lock held retries every 5 minutes for up to
  2 hours.
- **Judge:** if it fails or gives no usable answer, the first passing draft in writer order wins,
  with a warning.
- **Process and write:** two items from different sources with the same product and version are
  merged, and the write prompt asks for one entry per release. A title that restates the tag
  ("tool v1.2.0: Release v1.2.0") is shortened. The model's `url` is no longer validated, since
  the step replaces it.
- **Health check:** a run and `doctor` require only the models of guards that are on.
- **Docker:** `stop_grace_period` is 90m (was 30m).
- **Evals:** the replay serves each source up to the production cap. A label outside that window
  is "not visible" and left out of recall and leaks. The `digest eval` and `digest doctor`
  commands judge the host that the loader resolved the profile for.
- **Redaction:** one redactor serves the logger, the tracer, the loader and command output. It
  also hides percent-encoded secrets and the path of the Slack webhook. Run records, run files,
  digests, subjects and failure notes are redacted again just before they are saved or sent.
- **Stopping:** a second SIGINT or SIGTERM stops the running digest after its current step; a
  third ends the process.
- **Logs and doctor:** the RSS fetcher logs its per-feed warnings. `digest doctor` builds its
  model provider the same way a run does (`createModelProvider`).

### Fixed

- Entries of one feed that share a link (Google Cloud release notes) are no longer collapsed into
  one item. They get `?entry=<entry id>` on their URL.
- One bad feed entry no longer fails its source, and the empty GitHub Atom feed is recognized by
  its shape.
- A malformed numeric character reference (`&#x110000;`) no longer fails a source or throws in
  the link check; the link check rejects the draft.
- A truncated summary never ends in half an emoji.
- Summaries of hostile markup (long runs of `<`, an unclosed `<script>`) no longer take seconds to
  minutes to clean.
- A week that was only partly delivered is deduped the next week.
- A dry or forced run could replace `digest.md` after a channel had it, so a later resume sent the
  wrong text. It cannot now.
- A tick that met a held lock was dropped until the next restart.
- Orphaned run-lock temp files are removed at the next run.
- The `decide` state no longer overflows a small context because of long questions.

### Known limits

- Two hard gates are red on `light`: format (83%) and attack handling (90%), and the groundedness
  guard flags half of the clean control drafts. A fix is planned. `quality` and `fast` are still
  not measured.

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
