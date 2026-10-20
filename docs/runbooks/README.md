# Runbooks

Part of the [documentation home](../README.md).

One runbook per task, grouped by intent. Every runbook has the same eight headings, so you can
scan any of them the same way:

1. **Purpose**: what you get when it is done.
2. **When to use**: the situations, and when to use another runbook.
3. **Prerequisites**: what must be true first.
4. **Steps**: exact commands and edits.
5. **Verify**: how to prove it worked.
6. **Roll back**: how to undo it.
7. **Troubleshooting**: symptom, cause, fix.
8. **Related**: where to read more.

## Commands in runbooks

Examples use `pnpm digest <command>`. Other ways to run the same command:

| Setup  | Prefix                                                      |
| ------ | ----------------------------------------------------------- |
| Node   | `pnpm digest <command>`                                     |
| Built  | `node dist/artifacts/cli.js <command>` (after `pnpm build`) |
| Docker | `docker compose run --rm digest <command>`                  |

The global option `-c, --config <path>` (default `digest.config.json`) goes before the command
name. Look up any command in the [CLI reference](../reference/cli-commands.md).

## Find a runbook

### Set up

Install it, choose a profile, make the first run, schedule it. [Folder index](set-up/README.md).

| Runbook                                                                      | Use it to                                                                                    |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [Choose a profile and pull models](set-up/choose-profile-and-pull-models.md) | Pick the model profile that fits this machine, then pull exactly the Ollama models it needs. |
| [First run](set-up/first-run.md)                                             | Prove that a fresh install works end to end: Ollama, models, feeds and file output.          |
| [Install with Docker Compose](set-up/install-with-compose.md)                | Run the weekly scheduler (`digest serve`) as a container that restarts by itself.            |
| [Install with Node](set-up/install-with-node.md)                             | Run the `digest` CLI from a clone, with Ollama on the same machine.                          |
| [Schedule weekly runs](set-up/schedule-weekly-runs.md)                       | Make the digest run every week without you.                                                  |

### Configure

Change what it watches, how it checks, which models it uses, where it delivers. [Folder index](configure/README.md).

| Runbook                                                                             | Use it to                                                                                                                                             |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Add a source](configure/add-a-source.md)                                           | Collect releases or posts from one more RSS/Atom feed or GitHub repository.                                                                           |
| [Change focus areas](configure/change-focus-areas.md)                               | Change the topics the digest cares about.                                                                                                             |
| [Change guard mode](configure/change-guard-mode.md)                                 | Decide how several guards combine: block on the first flag (`any`, the default) or only when every active guard flags the same item or draft (`all`). |
| [Change models or writers](configure/change-models-or-writers.md)                   | Change which Ollama models write the digest: pick another profile, or replace the writer panel with your own list of model tags.                      |
| [Change the output folder](configure/change-the-output-folder.md)                   | Choose the folder where the finished digest files are written: `<week>.md` and `<week>.html` (and `<week>.failed.md` after a failed run).             |
| [Change the schedule and time zone](configure/change-the-schedule-and-time-zone.md) | Change the day and time `digest serve` runs the weekly digest, and the time zone it reads that time (and the ISO week) in.                            |
| [Change thresholds](configure/change-thresholds.md)                                 | Move the cut-off points that decide which scored items reach the writers and when a guard flags.                                                      |
| [Change timeouts and retries](configure/change-timeouts-and-retries.md)             | Give a slow model more time, or change how often a failed model call is tried again.                                                                  |
| [Remove or disable a source](configure/remove-or-disable-a-source.md)               | Stop collecting from one source.                                                                                                                      |
| [Set seed and temperature](configure/set-seed-and-temperature.md)                   | Control how repeatable or varied the model output is.                                                                                                 |
| [Set the judge](configure/set-the-judge.md)                                         | Turn the judge on or off.                                                                                                                             |
| [Set up email](configure/set-up-email.md)                                           | Send the weekly digest, and failure notes, by email through your own SMTP server.                                                                     |
| [Set up Slack](configure/set-up-slack.md)                                           | Post the weekly digest, and failure notes, to a Slack channel through an incoming webhook.                                                            |
| [Turn a guard on or off](configure/turn-a-guard-on-or-off.md)                       | Switch one safety check on or off, or a whole group of them.                                                                                          |
| [Update a source](configure/update-a-source.md)                                     | Change one entry of `sources` in `digest.config.json`: its URL, id, kind, `area` hint or `maxItems` cap, without losing the rest of the setup.        |

### Run

Start a run, rehearse one, replay a week, measure quality. [Folder index](run/README.md).

| Runbook                                         | Use it to                                                                                                                                                               |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Dry run](run/dry-run.md)                       | Run the whole pipeline (collect, guards, classify, process, write, select) and write the result to disk, while sending nothing.                                         |
| [Fetch sources only](run/fetch-sources-only.md) | Fetch the configured feeds the way a run does, with no models, and save the raw responses and the parsed items.                                                         |
| [Force a week](run/force-a-week.md)             | Run a week again from scratch with `digest run --force`, even though it already has a sent digest.                                                                      |
| [Preview a week](run/preview-a-week.md)         | Render a saved run's winning draft the way each channel shows it (Markdown, email, Slack) into files you can open.                                                      |
| [Run again](run/run-again.md)                   | Make a second digest for a week that already has one: enrich it, add sources, list every release, or favour a topic. The week's own digest stays as it is.              |
| [Run evals](run/run-evals.md)                   | Replay the recorded weeks and the labeled cases through the real pipeline and models, and print a scorecard with 18 measurements and a pass or fail for the hard gates. |
| [Run now](run/run-now.md)                       | Produce this week's digest and deliver it to every configured channel right away, instead of waiting for the schedule.                                                  |

### Observe

Read logs, follow one run, view traces, see history. [Folder index](observe/README.md).

| Runbook                                                   | Use it to                                                                                             |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [Follow one run](observe/follow-one-run.md)               | Watch a run while it works, see which step it is in, and tell a slow step from a stuck one.           |
| [Read the logs](observe/read-logs.md)                     | Find the log lines of one week, one step or one model call, and read what they say.                   |
| [Show a week](observe/show-a-week.md)                     | Read what a past run saved: a summary, the collected items, the scores, the drafts and the digest.    |
| [View run history](observe/view-run-history.md)           | List the past runs, newest first, with their status, item counts, duration and winning writer.        |
| [View traces in Jaeger](observe/view-traces-in-jaeger.md) | See one run as a timeline: how long each step and each model call took, and where a failure happened. |

### Debug

Find out why a run failed, was blocked, was quiet or lost an item. [Folder index](debug/README.md).

| Runbook                                                                     | Use it to                                                                                                                                    |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| [Debug a blocked run or a fallback digest](debug/blocked-run.md)            | Find out why every writer draft was rejected, and get a model-written digest out without weakening the checks.                               |
| [Debug a failed delivery](debug/failed-delivery.md)                         | Find out why the digest did not reach one channel (email or Slack), fix the cause, and send the saved digest to the channels that missed it. |
| [Debug a failed run](debug/failed-run.md)                                   | Find the step and the cause of a run that ended `failed` (exit code 1), fix it, and get the week to `sent`.                                  |
| [Debug a failing feed](debug/failing-feed.md)                               | Find out why one source fails or returns nothing, and fix the source or take it out.                                                         |
| [Debug a missing or wrong item](debug/missing-or-wrong-item.md)             | Find the first step where an item you expected was lost, or where an unwanted item got in, and turn a real miss into an eval case.           |
| [Debug a quiet week](debug/quiet-week.md)                                   | Find out where the items of a `quiet` week went, and decide whether the week was truly quiet or something upstream is wrong.                 |
| [Debug a slow model or out-of-memory](debug/slow-model-or-out-of-memory.md) | Find out why model calls are slow, time out or crash Ollama, and change one thing so the run finishes in a normal time.                      |
| [Debug a stuck lock](debug/stuck-lock.md)                                   | Find out who holds the run lock, decide whether it is a live run or a dead one, and free the lock safely.                                    |

### Recover

Finish a partly delivered week or run a week again. [Folder index](recover/README.md).

| Runbook                                                         | Use it to                                                                                                 |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| [Re-run a week](recover/re-run-a-week.md)                       | Run the current week again from the start, with new model calls, and send a new digest to every channel.  |
| [Resume a partial delivery](recover/resume-partial-delivery.md) | Send the digest a week already made to the channels that missed it, with no model call and no new digest. |

### Maintain

Upgrade the tool or its models, free disk, re-baseline evals, rotate secrets. [Folder index](maintain/README.md).

| Runbook                                                                       | Use it to                                                                                                                                                  |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Add an eval case from a bad week](maintain/add-eval-case-from-a-bad-week.md) | Turn a week where the digest got something wrong into test data, so a fix can be measured and the mistake shows up in the next scorecard if it comes back. |
| [Prune disk](maintain/prune-disk.md)                                          | Free disk by trimming old run folders, debug output and unused models, without losing the history the next run needs.                                      |
| [Re-baseline evals](maintain/re-baseline-evals.md)                            | Record a fresh scorecard for a profile and update the pages that quote it, so the written baseline matches what the code does today.                       |
| [Rotate secrets](maintain/rotate-secrets.md)                                  | Replace the SMTP password, the Slack webhook URL or the GitHub token with new ones, without leaking the old or the new value.                              |
| [Upgrade models](maintain/upgrade-models.md)                                  | Move to a newer model, or a newer build of the same tag, without breaking runs.                                                                            |
| [Upgrade the tool](maintain/upgrade-the-tool.md)                              | Move an installed copy to a newer version of the tool itself, on Node or in Docker, and check it before the scheduler uses it.                             |

### Release

Cut a release. [Folder index](release/README.md).

| Runbook                                   | Use it to                                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [Cut a release](release/cut-a-release.md) | Mark a version: a green build, an updated changelog, one signed release commit and a signed tag. |

## Not sure where to start?

| Situation                 | Go to                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| A run did not end `sent`  | [Triage](../operations/triage.md), then a runbook under Debug                               |
| A new machine             | [Getting started](../overview/getting-started.md)                                           |
| A setting you cannot find | [Configuration](../configuration/README.md)                                                 |
| Using Claude Code         | The `digest-cli` skill (`.claude/skills/digest-cli`) answers "how do I..." by pointing here |
