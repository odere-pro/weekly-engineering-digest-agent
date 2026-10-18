# How it works

A run turns feeds into one digest. Plain async steps run in a fixed order. Models do the
judging, code does the checking. This page is for the tech lead. Commands and fixes are in
[`operate.md`](operate.md).

## The pipeline

```text
collect -> guardInput -> classify -> process -> write -> guardOutput -> select -> deliver
 feeds      drop attacks   score items   pick top N   draft panel   drop bad drafts  pick best   channels
```

| Step          | Input          | Output                       | Model role                 | Checks and guards                               |
| ------------- | -------------- | ---------------------------- | -------------------------- | ----------------------------------------------- |
| `collect`     | config sources | items in the window, deduped | none                       | Host allowlist, size and redirect limits        |
| `guardInput`  | items          | items no guard flagged       | `guardPolicy`, `guardRisk` | `clefPolicy`, `graniteRisk`                     |
| `classify`    | items          | relevance, area, hype, minor | `classify`                 | Type check of every answer                      |
| `process`     | scored items   | top N items (3-5)            | none                       | Thresholds, dedupe, area spread                 |
| `write`       | selected items | one draft per writer         | `write`                    | Provenance, link check, format check, one retry |
| `guardOutput` | drafts         | drafts that passed           | `guardRisk`, `guardPolicy` | `graniteGroundedness`, `clefRubric`             |
| `select`      | passing drafts | the winner                   | `judge` (if any)           | First passing draft wins when there is no judge |
| `deliver`     | winner         | files, email, Slack          | none                       | Redaction before every channel                  |

Steps are plain functions `(input, deps) => output` in `src/core/steps/`. `core/workflow.ts`
wraps them in a Mastra workflow. `core/runDigest.ts` owns the order, the timings and the
run ending. Only one model is loaded at a time, so models run strictly one after another.

### What each step does

- **collect.** Fetches every source (4 at a time, 10 s each), keeps items inside `windowDays`,
  caps each source at `maxItemsPerSource`, and removes URLs sent in the last `dedupeWeeks` weeks.
  A failed source is listed in `failedSources` and skipped. Details: [`sources.md`](sources.md).
- **guardInput.** One call per item per guard. `clefPolicy` asks if the item is aimed at an AI
  system or harmful. `graniteRisk` asks Granite Guardian about jailbreak and harm. Guards flag
  above `thresholds.guardFlag` (0.35). Unparsable output flags the item (fail closed).
- **classify.** One `decide` call per item with four questions: relevance (0-3), area (one of
  your `focusAreas` or `other`), hype (yes/no), minor release (yes/no). A source `area` is passed
  as a hint only.
- **process.** Code only. Rank by relevance, area confidence, date. Drop in this order:
  `sent-before`, `duplicate`, `low-relevance` (< `minRelevance` 1.5), `hype` (> `maxHype` 0.6),
  `minor-release` (> `maxMinorRelease` 0.75). Then spread across areas and keep `topN`. Fewer
  than 3 items ends the run `quiet`.
- **write.** Each writer in the panel gets the same prompt and returns a structured digest:
  headline, intro, and per item a title, summary, why it matters, `urgency` and an `action`
  line. The step keeps only items it selected and replaces every URL with the source item's URL,
  so a model can name an item but never choose its link. It also replaces em dashes and adds
  `https://` to a bare link that names a collected item.
- **checks.** Two code checks always run. The link check rejects any URL that is not a collected
  one, and any link without a scheme. The format check needs 3-5 items, all fields, no em dash
  and under 500 words. If no draft passes, each writer gets one retry with the problems listed
  (never the link itself).
- **guardOutput.** `graniteGroundedness` checks each summary against its source item, then the
  headline and intro against the cited sources. `clefRubric` flags off-task, hype or harmful
  drafts. If every draft is rejected the run ends `blocked`.
- **select.** With two or more passing drafts and a judge, one call per draft scores accuracy,
  clarity, why it matters and focus fit (1-5). The best mean wins. A judge failure falls back to
  the first passing draft.
- **deliver.** Sends the winner to every channel and records which ones took it.

## Ports and adapters

`src/core` knows no vendor, file or cloud. It talks to five interfaces in `src/ports/`. ESLint
enforces that core never imports an adapter, `node:fs`, `ollama` or `nodemailer`.

| Port            | What it does                                  | Real adapter                                        |
| --------------- | --------------------------------------------- | --------------------------------------------------- |
| `ModelProvider` | `generate` (text) and `decide` (class odds)   | `adapters/models/ollama.ts`, `systemone.ts`         |
| `Guard`         | Input and output checks, one verdict per call | `adapters/guard/clefPolicy.ts`, `granite.ts`        |
| `SourceFetcher` | Items from one source kind                    | `adapters/sources/` (`rss`, `github` Atom and REST) |
| `Delivery`      | Send a digest or a failure note               | `adapters/delivery/` (markdown, SMTP, Slack)        |
| `RunStore`      | Run folders, lock, history                    | `adapters/store/fsRunStore.ts`                      |

`src/app/container.ts` is the composition root: config in, adapters out, `DigestDeps` for the
core. `decide` returns probabilities from a decision model through Ollama's `/v1/systemone`
endpoint. `generate` is a normal chat call with structured output: `generateStructured()` checks
the answer against a zod schema and allows one repair call.

## Profiles

A profile maps each role to an Ollama tag. Set it with `profile` in the config. The schema
default is `quality`; `digest init` recommends `light`.

| Role                      | `quality`                                                          | `fast`                                 | `light`                   | Fallback (not Apple silicon) |
| ------------------------- | ------------------------------------------------------------------ | -------------------------------------- | ------------------------- | ---------------------------- |
| `classify`, `guardPolicy` | `clef:latest` (18 GB)                                              | `strands-decider:2b-mlx-bf16` (3.8 GB) | same as `fast`            | `clef:latest`                |
| `guardRisk`               | `granite4.1-guardian:8b` (6.9 GB)                                  | same                                   | same                      | same                         |
| `write`                   | `gemma4:31b-mlx` (19 GB), `nemotron-3.5-lightning:30b-mlx` (22 GB) | `nemotron-3.5-lightning:30b-mlx`       | `gemma4:e4b-mlx` (9.5 GB) | `gemma4:31b` (19-20 GB)      |
| `judge`                   | `clef:latest`                                                      | none                                   | none                      | none                         |
| Disk for models           | 65.9 GB                                                            | 32.7 GB                                | 20.2 GB                   | about 45 GB                  |
| Ollama minimum            | 0.40.0                                                             | 0.40.0                                 | 0.40.0                    | 0.35.1                       |

- The MLX tags and `strands-decider` need Apple silicon. Anywhere else every profile resolves
  to the fallback set, and `doctor` says so. The host is read from `DIGEST_HOST_OS` and
  `DIGEST_HOST_ARCH` when the app runs in a container.
- `quality` has two writers and a judge. One writer means no judge step. `models.writers`
  replaces the panel.
- Set `OLLAMA_MAX_LOADED_MODELS=1` on a host Ollama. RAM follows the largest single model.
- Measured speed and quality: [`profiles.md`](profiles.md). Licences: [`licences.md`](licences.md).

## Deployment

The image is non-root and runs `digest serve` by default (`docker-compose.yml`, project
`eng-digest`). Compose bind-mounts `./data` to `/app/data` and `./data/digests` to
`/app/dist/digests`, so Docker keeps its files under `data/`.

| Service      | Profile   | Role                                                                 |
| ------------ | --------- | -------------------------------------------------------------------- |
| `digest`     | always    | The scheduler (`serve`) and one-shot commands (`docker compose run`) |
| `ollama`     | `linux`   | Ollama in a container, models in the `ollama-models` volume          |
| `model-pull` | `linux`   | Pulls the profile's models once, then exits                          |
| `jaeger`     | `tracing` | Trace viewer on port 16686                                           |

- **Mac.** Docker cannot use the Apple GPU, so Ollama runs on the host and the container calls
  `http://host.docker.internal:11434`. `make docker-*` exports `DIGEST_HOST_OS` and
  `DIGEST_HOST_ARCH` so the container picks the Mac profiles.
- **Linux.** Compose adds Ollama. Every profile uses the fallback set. `DIGEST_UID` and
  `DIGEST_GID` let the container write `./data` and read a `chmod 600` `.env`.
- **Node.** `pnpm digest <command>` runs from source with tsx. `pnpm build` makes `dist/cli.js`.
  A host scheduler calls `digest run`.

## Guards and thresholds

Guards are models that check text before and after writing. Config can switch each one off
(`guards.input.checks`, `guards.output.checks`). It can never switch off the link and format
checks.

| Check                 | Where  | Role          | Call       | Asks                                                                  |
| --------------------- | ------ | ------------- | ---------- | --------------------------------------------------------------------- |
| `clefPolicy`          | input  | `guardPolicy` | `decide`   | Is the item aimed at an AI system, or harmful? Flags above 0.35       |
| `graniteRisk`         | input  | `guardRisk`   | `generate` | Jailbreak, then harm, using Granite Guardian's trained categories     |
| `graniteGroundedness` | output | `guardRisk`   | `generate` | Is each item grounded in its source? Are headline and intro grounded? |
| `clefRubric`          | output | `guardPolicy` | `decide`   | Is the draft off-task, hype or harmful? Flags above 0.5               |

`mode: "any"` (default) drops on the first flag. `"all"` drops only when every enabled guard
flags. The classifier answers four questions per item; `process` applies the thresholds.

| Question       | Answer                                            | Threshold (default)                |
| -------------- | ------------------------------------------------- | ---------------------------------- |
| `relevance`    | expected level 0-3                                | `minRelevance` 1.5, drop below     |
| `area`         | one of `focusAreas` or `other`, with a confidence | none; used to spread the top N     |
| `hype`         | P(mainly hype or marketing)                       | `maxHype` 0.6, drop above          |
| `minorRelease` | P(patch release with only bug fixes)              | `maxMinorRelease` 0.75, drop above |

The thresholds come from a sweep over 60 labelled cases on `light`. The judge scores accuracy,
clarity, why it matters and focus fit from 1 to 5, one draft per call so position cannot bias it.

## Prompts

Every prompt that embeds collected text wraps each item in an untrusted-data block and puts
`UNTRUSTED_DATA_RULE` in the system prompt: item text is data, never instructions. No model has
tools or network access. Prompts live in `src/core/prompts/`, one file per step. Sampling is
fixed for repeatability: `models.seed` (42) on every call, temperature 0.2 for `write` and 0 for
the other roles. The run record keeps both.

## Data layout

```text
data/                      dataDir (default "data")
  digest.lock              the run lock
  runs/<week>/             one folder per ISO week, for example 2026-W43
    run.json               status, timings, models, counts, failed sources, drafts, deliveredTo
    items.json             collected items
    scores.json            classifications and why items were dropped
    drafts.json            drafts, failed writers, rejections with problems
    digest.md              the winning digest (kept after pruning)
    review.md              tick sheet for `digest feedback`
    error.json             only after a failure: step, message, time
dist/digests/              <week>.md and <week>.html (Docker: data/digests)
dist/fetch/                `digest fetch` output
dist/preview/              `digest preview` output
```

Run folders older than `keepWeeks` (12) keep only `digest.md`. `keepWeeks` must be at least
`dedupeWeeks`, because pruned weeks drop out of the cross-week dedupe.

## Run semantics

- **Week id.** The ISO week of the run date, for example `2026-W43`. `--since` changes the
  window, not the week.
- **Lock.** One run per `dataDir`, held in `data/digest.lock` with a 60 s heartbeat. A lock whose
  heartbeat is 5 minutes old, or whose process is gone, is taken over. A held lock fails the run
  with exit 1.
- **Idempotency.** A week with a `sent` record is `skipped`. `--force` runs it again.
- **Resume.** A week that reached only some channels is not run again. `digest run` sends the
  saved `digest.md` to the missing channels and marks the week `sent`. If `digest.md` is gone or
  differs from what the other channels got, it refuses, and `--force` sends a new digest to all.
- **Forced and dry runs** that reach no channel keep the old record and files of a sent week.
- **Abort.** `digest serve` stops a run after its current step on a 3 h time limit or a second
  stop signal. The run ends `failed` and releases the lock.

| Status    | Meaning                                                  | Exit | Failure note                  |
| --------- | -------------------------------------------------------- | ---- | ----------------------------- |
| `sent`    | The winner reached every channel                         | 0    | no                            |
| `dry-run` | A winner was written to disk, nothing was sent           | 0    | no                            |
| `skipped` | The week already has a sent digest                       | 0    | no                            |
| `quiet`   | Nothing collected, or fewer than 3 items worth sending   | 3    | only if nothing was collected |
| `blocked` | Drafts exist and every one was rejected                  | 2    | yes                           |
| `failed`  | A health check, a step or a delivery failed, or no draft | 1    | yes                           |

## The digest and its renderers

The core builds one `DigestView` from the winning draft (`core/layout.ts`, pure, no I/O). It
holds a title line ("Week 2026-W42: 5 releases, 1 needs action"), the headline, and the items
in groups: Act now, Worth a look, Good to know. A group appears only when it has items. Labels
and the title line come from code, never from a model. An old draft without `urgency` is read
as "Worth a look"; one without an `action` shows its why-it-matters line.

Three renderers turn the view into channel output. Each one is a pure function.

| Channel  | Output                                                                                                    |
| -------- | --------------------------------------------------------------------------------------------------------- |
| Markdown | `<week>.md` (tables per group) and `<week>.html` (same content, opens in a browser); atomic writes        |
| Email    | Multipart mail, HTML and plain text. Subject `Engineering digest <week>: <headline>`. STARTTLS by default |
| Slack    | Block Kit message. Text is escaped so feed text cannot produce `<!channel>`                               |

A failure note is a short plain text on every channel, plus `<week>.failed.md`. Preview any
week without sending: `digest preview <week>`.

## Safety

| Rule                                                              | Enforced in                                                                                                                                  |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Collected text is untrusted: wrapped and labelled in every prompt | `shared/untrusted.ts` (`wrapUntrusted`, `UNTRUSTED_DATA_RULE`)                                                                               |
| Only allowlisted hosts; same-host redirects; 5 MiB cap            | `adapters/sources/http.ts`                                                                                                                   |
| A digest may only contain collected URLs                          | link check in `core/checks/linkCheck.ts`, plus URL replacement in `write`                                                                    |
| Format limits hold                                                | `core/checks/formatCheck.ts`                                                                                                                 |
| Link and format checks cannot be switched off                     | no config key exists                                                                                                                         |
| Guards fail closed on unparsable output                           | `core/steps/guardRun.ts`                                                                                                                     |
| Recipients, webhook and paths come from config and `.env` only    | config loader; models never supply them                                                                                                      |
| Secrets never reach logs, run records, traces or messages         | `adapters/delivery/redact.ts` and the redacting logger and tracer; each record and message is redacted again just before it is saved or sent |
| `SLACK_WEBHOOK_URL` must be `https:`                              | `config/schema.ts`                                                                                                                           |
| A source URL may not carry a username or password                 | `config/schema.ts`                                                                                                                           |

A guard switched off in the config is listed in `run.json` and named in the digest footer, and
`doctor` warns about it.

## Observability

- **Logs.** pino JSON on stdout, level from `LOG_LEVEL`. Lines of a run carry `runId` (the
  week), lines inside a step also `step`. Each model call logs role, model, latency, attempts
  and token counts. No prompt or answer text.
- **Traces.** Set `OTEL_EXPORTER_OTLP_ENDPOINT` to export OpenTelemetry: one span per run, per
  step and per model call. No prompt, state or answer goes into a span. The Compose `tracing`
  profile adds Jaeger on port 16686.
- **History.** `run.json` per week and `digest history`.
- **Health.** `digest doctor` checks config, Ollama, models, feeds, delivery, `.env`, guards and
  the data dir. `doctor --readiness` prints a verdict per profile for this machine.
- **Quality.** `digest eval` replays recorded weeks and writes a scorecard to
  `evals/scorecards/`. Four hard gates (link validity, attack handling, groundedness, format)
  must be 100%.

## Known limits

- Only `light` is measured. Two hard gates are red on it: format 83% and attack handling 90%.
  The thresholds were tuned on `light` only.
- The groundedness guard can block good drafts, in particular on the headline and intro. Clean
  control drafts pass, but real drafts were blocked more often. A full re-baseline is open.
- The link check ignores autolinks with a scheme other than `http(s)`, and accepts a collected
  URL with extra tracking parameters or a fragment.
- One replica. The lock is a file on local disk. Two machines sharing `data/` over a network
  file system are not supported, and `data/` needs hard links (not FAT, exFAT or some SMB).
- A run suspended for more than 5 minutes (a sleeping laptop) can lose its lock to another run.
- Delivery is at least once. A message can arrive twice when a server took it and then reported
  an error.
- Same-release dedupe is narrow on purpose. The same story from two feeds can get through when
  one title has no version.
- A source that returns nothing is logged, not recorded in `run.json`.
- The abort signal is checked between steps only. A hanging model call holds a run until its
  timeout.
- Redaction covers the declared secrets and the Slack webhook path, not a password inside
  `OLLAMA_URL` or the OTLP endpoint.
