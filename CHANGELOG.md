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
- **One failure note per week:** a week that fails in `digest serve` sends one note, from its last
  attempt, not one per attempt. `RunOptions.notifyFailure` (default true) lets a caller hold the
  note of a failed run back. The scheduler holds it on every attempt it will retry, and
  `SchedulerOptions.onGiveUp` sends it once if the retry never runs: the service is stopped, the
  lock stays held, or the retry throws. A run that was told to stop, or that needs `--force`,
  sends its note at once.
- **Delivery retry:** an email or Slack send is tried again twice (after 5 and 10 seconds), but
  only when the failure shows that nothing was sent: a failure while connecting, an HTTP 429 or
  5xx answer, or an SMTP 421, 450 or 451 reply. A reset or a timeout after the message was
  written is not retried. A message can still arrive twice when the server took it and then
  answered with one of those errors.
- **Traces:** one `model.generate` or `model.decide` span per model call, with a `model.usage`
  span inside it (role, model, latency, tokens). No prompt or answer text.
- **Forced runs:** `digest run` says why a forced run kept the week's record and folder. The
  reason is `RunResult.kept`, and the command prints it as its last line.
- **Doctor checks:** a `dataDir` that is a file or a dangling symlink, a `markdown.dir` that is
  not writable, a development build or a pre-release of the minimum Ollama version, an unquoted
  `.env` value cut at a `#`, and a warning that `light` off a Mac uses the heavy fallback.
- **Groundedness:** the Granite guard also checks the headline and intro against the sources the
  digest cites. It uses its own criterion for them: a made-up fact about a release is ungrounded,
  and editorial framing is not.
- **Logs:** a warning when a source yields no usable item, and a `questionChars` field in the
  `decide state trimmed` warning. The GitHub fetcher warns once per source about releases it
  skipped, like the RSS fetcher, and `pnpm eval:record` prints skipped feed entries as `WARNING:`
  lines in its report.
- **CI:** an `image-scan` job (Trivy 0.75.0, pinned by digest, fails on HIGH and CRITICAL). It has
  not run yet.
- **Evals:** per-week detail (`byWeek`) on the format and link metrics, the item ids of every
  stability run, a `guardAttackRecall` metric (soft gate, 90%), an optional eval judge for
  profiles without one, and `evals/judge/` with a grading sheet and a calibration check.
- **Eval judge:** `digest eval` scores the winning digests of a profile that has no judge when
  `EVAL_JUDGE` names a model. Set it in `.env` or the shell (the shell wins). Before the replay,
  `digest eval` checks that Ollama lists the tag as a decision model. A typo or a missing model
  now fails at once with a clear message, not after the replay. It never pulls a model. This has
  not run against a real judge yet. `digest eval` also prints the weeks with problems and the
  item ids of each stability run.
- **Scorecard case names:** the `attackHandling` detail names the attack case that reached the
  digest (`reachedDigest:<case>`) and the ones no guard checked (`unchecked:<case>`). The
  `guardFalseBlocks` detail can name the clean cases a guard flagged (`flagged:<guard>:<case>`),
  but the eval runner does not pass the case ids yet. Old scorecards still load.
- **Light scorecard after wave 5:** `evals/scorecards/2026-10-17-light-wave5.json`, next to the
  v0.1.0 one. The hard gates are still red: format 83% (was 67%) and attack handling 90% (was
  100%). Guard false blocks are 50% (was 0%), from the new headline and intro check. The causes
  of the format and false-block results are fixed (see Fixed); the scorecard has not been re-run.
- **Adapter pipeline:** every source goes through one pipeline, and an `rss` entry with no text
  in the feed gets the first paragraphs of its own page (the page may redirect to the feed's own
  host or to a host of the default source list; 4 seconds per source). Summary text comes from
  `content:encoded`, then `content`, `summary` and `description`.
  `pnpm tsx evals/recordSources.ts --pages` records the pages.
- **Source evals:** the real response of each default source is recorded in `evals/sources/`
  (`pnpm tsx evals/recordSources.ts`), with a hand-checked list of the items it must yield. Two
  soft metrics, `sourceParse` (95%) and `sourceSummaryFill` (90%), check the fetchers against it.
- **Threshold sweep:** it picks on a training split and also scores a held-out one, and warns when
  the two differ by more than 0.1.
- **Classifier source tag:** a run passes each source's `area` to the classifier as a line
  `Source tag: <area>`. It is a hint: the classifier still picks the area itself, from your focus
  areas. Its effect is not measured yet.
- **Internals:** `FetchError`, `DeliveryError`, `modelsInUse`, `LoadedConfig.platform`,
  `effectiveThink`, and `counts.afterProcess` in the run record (filled by the run).
  `applyGuards` takes a limit for calls in flight per guard (`GUARD_CONCURRENCY`, default 1, so
  the behaviour is unchanged), and `guardInput` and `guardOutput` take an optional `concurrency`.
  `toJudgeScore` is exported from the select step and is the only implementation.

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
- **Run id on logs:** model-call lines (and the retry and abort lines of the Ollama adapter) and
  the fetcher warnings now carry the `runId`, and the `step` when they come from inside a step.
  The weeks of one `digest serve` process, and the steps of one week, can be told apart.
- **Delivery errors:** a failed email or Slack send keeps its error code, HTTP status or SMTP
  reply and a redacted copy of its causes. The text names the code when it hides it, as in
  `fetch failed (ECONNREFUSED)`.
- **Guards:** a guard checks one item at a time, as before. The limit is now a named constant,
  `GUARD_CONCURRENCY`, and stays 1. On the `light` profile limits 2 and 4 gave the same verdicts
  and were no faster, because Ollama served the calls one at a time.

### Fixed

- The link check no longer rejects a collected URL that has `www.` in it, such as
  `https://www.docker.com/blog/...`. It read the `www.` as a link without a scheme. This bug, and
  not the writer, left 2026-W39 without a digest in the wave 5 scorecard. A bare `www.host`,
  `//host` or `https:host` link is still rejected.
- The write step adds `https://` to a link the writer left bare when it names a collected item
  (`www.host/path` or `//host/path`). The retry prompt now says what is wrong with a link (no
  `https://` scheme, or not one of the item urls) and still shows no link.
- The groundedness guard no longer flags clean drafts for their headline and intro. It judges them
  with its own criterion instead of Granite's generic one. On `light`, clean control drafts flagged
  by groundedness went from 5 of 10 to 0 of 10, and all 10 groundedness attack drafts are still
  caught. This is a targeted check, not a full eval.
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

- The `light` scorecard is still the one from wave 5. In it, format (83%) and attack handling
  (90%) are red, and the groundedness guard flagged half of the clean control drafts. Two causes
  are fixed since then (see Fixed): the 2026-W39 failure was a link check bug, and the groundedness
  false blocks came from the headline and intro check. The attack miss (one attack item reached a
  digest) is not fixed. A full `light` re-baseline has not been run, so no new `light` numbers are
  published. `quality` and `fast` are still not measured.
- A targeted replay of the recorded weeks after the groundedness change still blocked some real
  drafts, for an ungrounded item or an ungrounded headline. So "0 of 10 clean controls flagged"
  does not mean no real draft is blocked. The re-baseline will show the real rate.
- The link check does not look at autolinks with a scheme other than `http` or `https`
  (`<ftp://host/x>`, `<javascript:...>`, `<mailto:...>`). It also accepts a collected URL with
  extra tracking parameters or a fragment, because it ignores both when it compares, and they can
  hold a second URL. The review of the link check found these; they are not fixed yet.

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
