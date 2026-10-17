# Runbook

What to do when a run does not end `sent`. Install and commands are in the [README](../README.md).
How runs work is in [`system-design.md`](system-design.md).

In Docker, put `docker compose run --rm digest` in front of every `digest` command below, and
read files under `./data` on the host. Without Docker, use `pnpm digest` or `node dist/cli.js`.

## Start here

1. Read the status: `digest history -n 4`. The newest row is the run to look at.
2. Open the record: `data/runs/<week>/run.json`. It has the status, the timings, the models, the
   counts, the failed sources and every draft with the checks that rejected it.
3. After a failure, also open `data/runs/<week>/error.json` (step, message, time, stack).
4. Run `digest doctor`. It checks Ollama, models, feeds, delivery, `.env`, guards and the data
   dir, and prints a `fix:` line for each problem.
5. Logs are JSON on stdout. In Docker: `docker compose logs digest`. Each line has `runId` and
   `step`. Set `LOG_LEVEL=debug` in `.env` for more.
6. Fix the cause, then run again (`digest run`, or `digest run --force` if the week was sent).

## What each status means

| Status    | Exit | Alert sent?                     | Go to                                |
| --------- | ---- | ------------------------------- | ------------------------------------ |
| `sent`    | 0    | no                              | Nothing to do                        |
| `dry-run` | 0    | no                              | Nothing to do. Nothing was delivered |
| `skipped` | 0    | no                              | [Skipped](#skipped)                  |
| `quiet`   | 3    | only when nothing was collected | [Quiet](#quiet-exit-3)               |
| `blocked` | 2    | yes                             | [Blocked](#blocked-exit-2)           |
| `failed`  | 1    | yes                             | [Failed](#failed-exit-1)             |

The alert is a short failure note on every delivery channel: a file `<week>.failed.md` in the
Markdown folder (default `data/digests`), and the email or Slack message if those are set. Email
and Slack notes are titled "Weekly digest `<week>` failed at `<step>`". It is best effort: a
channel that cannot take the note is only logged. No note is sent in a dry run.

## Failed (exit 1)

The note names the step. Find it in the note title or in `error.json`.

### Before any step: `Ollama is not reachable` or `Ollama is missing models`

The run checks Ollama before it collects anything, and sends nothing.

1. Start Ollama (`ollama serve`, or open the Ollama app), or fix `OLLAMA_URL` in `.env`.
2. In Docker, `localhost` is the container itself. On a Mac use `http://host.docker.internal:11434`.
   On Linux leave `OLLAMA_URL` unset so Compose uses its own `ollama` service.
3. For missing models, run the `ollama pull <tag>` lines that `digest doctor` prints. On Linux
   Compose, run `docker compose --profile linux up -d` again: `model-pull` pulls them.
4. Run again.

### Step `collect`

Failed feeds never fail this step; they are listed under `failedSources` in `run.json`. If
`collect` itself fails, read `error.json`. A run with feeds that all fail ends `quiet` instead
(see [Quiet](#quiet-exit-3)).

### Steps `guardInput`, `classify`, `write`, `guardOutput`, `select`

A model call failed: a timeout, a model that vanished, or invalid output that one repair did not
fix. Calls are retried twice before a step fails.

1. Run `digest doctor`. Fix missing or wrong models first.
2. Check that Ollama is not out of memory. Only one model should be loaded
   (`OLLAMA_MAX_LOADED_MODELS=1`).
3. If the model is just slow, raise its timeout under `models.timeoutsMs` in the config, for
   example `{ "write": 900000 }`. The minimum is 1000 ms.
4. If a guard model is not installed and you accept the risk for now, switch that guard off
   under `guards`. The digest footer will say so. Switch it back on later.
5. Run again.

One writer failing does not fail the run: the next writer still runs. When every writer fails, the
run is `failed` at step `write`, and the reasons are in `drafts.json` under `failures`. The run is
`blocked` only when drafts exist and none of them passes the checks and guards.

### Step `deliver`

The winning digest was written, but at least one channel failed. The error names the channels
that did get the digest, and `deliveredTo` in `run.json` lists them. Their URLs count as sent, so
next week's digest will not repeat them.

1. Check the channel in `digest doctor`: `email` needs `SMTP_PASSWORD`, `slack` needs
   `SLACK_WEBHOOK_URL` (an `https:` URL), both in `.env`.
2. Check the SMTP host, port and TLS settings under `delivery.email`, and the webhook.
   Slack redirects count as errors.
3. The winning digest is in `data/runs/<week>/digest.md`. Send it by hand if it is urgent.
4. Run `digest run`. The run does not start over: it sends the saved `digest.md` to the channels
   that missed it, with no model call, and then marks the week `sent`. `serve` does the same
   when it catches up. A channel that got the digest does not get it twice.
5. If the run says `digest.md` is gone or no longer matches the digest the other channels got, it
   sends nothing. Run `digest run --force` only when you accept a new digest on **every**
   channel, so the channels that already got the week get a second one.

### `Run aborted before the <step> step: ...`

A caller stopped the run between two steps. In `digest serve` that is the run time limit
(`run timed out after 3 h`; the next restart catches the week up) or a second stop signal. The
run keeps what the finished steps did, writes `error.json`, sends the failure note and releases
the lock. `digest run` never sets a signal, so you only see this from the service. A model call
that hangs is the usual cause of a timeout: see [Ollama or a model is slow](#ollama-or-a-model-is-slow-or-out-of-memory).

### Other failures with exit 1 and no run record

| Message                                                    | Cause and fix                                                                                   |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `Another run is in progress (pid ..., week ...)`           | The lock `data/digest.lock` is held. See [Lock](#a-run-says-another-run-is-in-progress)         |
| `Invalid environment ...` or a config error naming a field | Fix the field in `digest.config.json` or `.env`. `digest doctor` shows the same message         |
| `Could not save the run record ...`                        | The data dir is not writable or the disk is full. A note was sent first. Fix it, then run again |
| `Invalid --since ...`                                      | Use a whole number of days from `1d` to `31d`                                                   |
| A configured channel has no secret                         | The app refuses to start and names the variable. Add it to `.env`                               |

## Blocked (exit 2)

Every draft was rejected, so nothing was sent. The note names each writer and the checks that
rejected it. The same list is under `drafts` in `run.json` (`rejectedBy`) and in the `digest run`
output (`Rejected draft: <writer> (<checks>)`).

| Check id              | Meaning                                                                                                                                                                                       | What to do                                                                                                         |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `write`               | A writer made no draft (timeout, invalid JSON after repair, or fewer than 3 valid items) while another writer's draft was rejected. If every writer fails, the run is `failed`, not `blocked` | Check the model and its timeout; see the `write` step above                                                        |
| `linkCheck`           | A URL in the draft is not in the collected items, or a character reference names no Unicode character                                                                                         | Never turn it off. Run again; if it repeats, read `rejections` in `drafts.json` and keep the draft as an eval case |
| `formatCheck`         | Wrong item count, a missing part, an em dash, or 500 words or more                                                                                                                            | Read `rejections` in `drafts.json`. Run again; if it repeats, try another writer in `models.writers`               |
| `graniteGroundedness` | A summary is not backed by its source item                                                                                                                                                    | Run again. If it repeats on one writer, replace that writer                                                        |
| `clefRubric`          | The draft was off-task, hype or harmful                                                                                                                                                       | Run again. If it repeats, read the draft in `drafts.json`                                                          |

A draft that fails `linkCheck` or `formatCheck` is not final. When every draft fails them, each
writer gets one retry, and the prompt lists what was wrong. `drafts.json` has a `rejections` list:
for each rejected draft, the writer, the attempt (1 is the first draft, 2 is the retry), the check
ids and the first five problems. A writer with a rejection for attempt 1 and none for attempt 2
either passed the checks on its retry, or has an entry with `retry: true` under `failures` (the
retry made no draft, and the first draft stays). The problems quote the model, so they are in
`drafts.json` and the log only, never in the run record or the failure note.

Then run again with `digest run`. Use `--force` only for a week that was already sent. A forced
run that does not send keeps the old sent record and that week's files (`digest.md`,
`drafts.json`, `items.json`, `scores.json`), so a week that was sent never looks unsent. The
command prints no Digest line then; its last line says why, for example "Kept the sent run
record; this forced run did not end sent. The week's run folder is unchanged." The same reason is
in the log.

If a guard blocks good drafts week after week, do not switch it off first. Read the draft in
`data/runs/<week>/drafts.json`. A guard set to `"mode": "all"` blocks less, but protects less.

## Quiet (exit 3)

Fewer than 3 items were worth sending. This is often normal. Look at the counts in
`digest history` (`collected → digest items`) and in `run.json` (`counts`).

| Situation                             | What to check                                                                                                                                                              |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `collected` is 0, a failure note came | Every feed failed or the window had nothing. Check `failedSources` in `run.json` and `digest doctor` (a `source` line per feed). Check the network                         |
| `collected` is above 0, no note       | Items were dropped as already sent, duplicates, low relevance, hype or minor releases, or by the input guards. A quiet week is a valid result                              |
| Quiet again and again                 | Widen the window with `digest run --since 14d`. Check `focusAreas` against the sources. Check that the input guards are not flagging every item (`counts.afterGuardInput`) |

Only a run with zero collected items sends a note. A quiet week with items sends nothing.

## Skipped

The week already has a sent digest, so the run did nothing (exit 0, no record). This is the
idempotency rule: the scheduler can run twice and send once. To send the week again, use
`digest run --force`.

## Operations

### A run says "Another run is in progress"

Only one run can hold `data/digest.lock` at a time (one per `dataDir`).

1. Check for a real run: `docker compose ps`, `docker compose logs digest`, or `ps` on the host.
   If a run is going, wait for it.
2. If none is running, do nothing first. The next run takes over a stale lock by itself. A lock
   is stale when its process is gone, when its heartbeat is 5 minutes old (including a lock
   from another container), or when it is older than 6 hours without a heartbeat.
3. If it still refuses after that, stop all containers and processes that use this `data/`
   folder, then delete `data/digest.lock`.

Do not share one `data/` folder between machines over a network file system.

A run that is killed while it writes the lock can leave a temp file in `data/`, named
`digest.lock.<pid>.<uuid>.tmp` (or `digest.lock.takeover.<pid>.<uuid>.tmp`). They are harmless.
Every run that asks for the lock removes the ones older than 10 minutes, and logs
`Removed orphaned run lock temp files`. Files with any other name are never touched.

What the lock does not cover:

- **A run that hangs but stays alive keeps its lock.** The heartbeat comes from the process, not
  from the progress of the run. If a model call hangs and the process keeps running, the lock
  stays fresh and every new run is refused. Stop that process or container
  (`docker compose restart digest`). The next run then takes the lock over, at the latest 5
  minutes after its last heartbeat (at once when it can see that the process is gone).
- **A frozen run can overlap with the next one.** If the holder is suspended for more than 5
  minutes (a laptop that sleeps, a paused VM or container), another run may take its lock. When
  the first run wakes up it logs `Run lock is no longer ours` and stops refreshing the lock, but
  its run carries on, so both can write `data/runs/<week>/`. If you see that warning, check
  `digest history` for that week before you run it again.
- **Hard links are required.** The lock file is created with a hard link, so it never appears
  half written. `data/` must be on a file system that supports them (most local ones do: ext4,
  XFS, APFS, NTFS). On FAT, exFAT, some SMB shares and some FUSE mounts the run fails with an
  error such as `EPERM` or `ENOTSUP` from `link`, not with "Another run is in progress". Point
  `dataDir` at a local disk.

### The scheduler did not run

1. Docker: `docker compose ps` must show `digest` running. Start it with `docker compose up -d`
   (Linux: add `--profile linux`). `serve` catches up at start: if this week's slot has passed,
   it runs the week when it has no run, or its last run `failed` or was a `dry-run`. It leaves a
   week that is `sent`, `quiet` or `blocked` alone. A catch-up of a partly delivered week only
   sends the missing channels.
   A run that ends `failed` is tried again at most twice, 30 minutes apart (the log says
   `The run ended failed; will retry`), and each failed attempt sends its own failure note, so one
   cause can bring up to three notes. It is not tried again when it hit its 3-hour time limit, or
   when the error says to use `digest run --force`. After that the week waits for the next
   restart or a manual `digest run`.
2. Read the logs for `Scheduler started`: it shows the cron, the time zone and `nextRun`. A
   warning `The schedule has no upcoming run` means `schedule.cron` is wrong.
3. The container uses the time zone in `schedule.timeZone`. A host timer (launchd, systemd,
   `schtasks`) uses the machine's local time instead.
4. Native install: check the OS timer you saved from the `digest init` output.

### Stopping while a run is in progress

`docker compose stop` waits up to 90 minutes for the running digest to finish
(`stop_grace_period` in `docker-compose.yml`). The quality profile took about 59 minutes for a
week of 131 items on the reference laptop, so 90 minutes leaves about half again. An idle
container stops at once. A container that is killed anyway leaves a lock; see above. When
`serve` starts again it catches up the current week if that week has no run, or its last run
`failed` or was a dry run. The leftover lock can refuse it for up to 5 minutes; `serve` tries
again every 5 minutes for up to 2 hours, so nothing needs doing. If your runs take longer than 90
minutes, raise `stop_grace_period` and the value that `docker/validate.sh` checks together.

To stop sooner, send the stop signal a second time (Ctrl-C twice when `serve` runs in a
terminal). The running digest then stops after its current step and ends `failed`; a third signal
ends the process at once. A run that is still going after 3 hours is stopped the same way.

### Ollama or a model is slow or out of memory

Use a smaller profile in the config (`fast` or `light`), or give `models.writers` a single
writer. Keep `OLLAMA_MAX_LOADED_MODELS=1`. The largest model is about 19 GB.

### Delivery retries

A send to email or Slack that fails with a network error, a timeout, an HTTP 5xx answer or an SMTP
4yz reply is tried again twice, after 5 and 10 seconds (the log says
`Delivery failed with a transient error; will retry`). Any other error, such as a wrong password,
a Slack 4xx or an SMTP 5yz reply, fails the channel at once. If the first try reached the server
and only its answer was lost, the message can arrive twice.

### Feeds

A feed that keeps failing is skipped, not fatal. `digest doctor` shows one `source` line per
feed. Fix the URL or remove the source from `digest.config.json`. For GitHub rate limits, add a
`GITHUB_TOKEN` to `.env`. A rate-limited GitHub source is not retried, because GitHub asks you
to wait longer than a retry would.

A feed that redirects to another host, redirects from https to http, or sends more than 5 MiB
fails its source, and the error names the host or the size. Put the URL the feed really lives on
in the config. A source URL may not hold a username or password; the config will not load.

A source that returns no usable item in the window is logged as a warning, `Source returned no
usable items`. The run record does not list it, and a quiet week looks the same. If a feed stays
silent for weeks, open it in a browser and check that its format did not change.

An error in `failedSources` is cut to 300 characters.

### Disk

Run folders older than `keepWeeks` (default 12) keep only `digest.md`. Delete `data/runs/<week>`
folders by hand if you need space sooner. Keep at least the last `dedupeWeeks` weeks, or the digest
may repeat items it already sent.

## Keep for later

Before you change a prompt, a threshold or a model, save the `data/runs/<week>/` folder of a bad
week. It is the raw material for a new eval case. See `evals/` and `digest eval`.
