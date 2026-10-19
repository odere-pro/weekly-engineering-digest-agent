---
name: digest-cli
description: Onboard a user to the `digest` CLI of this repo and answer "how do I..." questions by routing to the right runbook and command. Use when asked to install, set up, run, schedule, configure, debug, recover or maintain the weekly engineering digest, to explain a `digest` command, flag, exit code or run status, or to find where a setting lives.
---

# Digest CLI

The `digest` CLI collects feeds and writes a weekly digest with local Ollama models. This skill
gets a new user running and sends every other question to one runbook in `docs/runbooks/`.

## Ground rules

- Never read `.env`, and never print a secret, a webhook URL or a password.
- Never invent a flag or a config key. Check `pnpm digest <command> --help` and
  `src/config/schema.ts` (full list: `docs/reference/config-keys.md`).
- Ask before anything that sends or repeats a delivery (`run` without `--dry-run`, `--force`),
  deletes data (`data/runs/`, `data/digest.lock`) or changes the schedule.
- Never push or merge. Commits are the maintainer's.
- Prefer `--dry-run` while exploring. It writes the digest files and sends nothing.

## Command prefix

| Setup  | Prefix                                            |
| ------ | ------------------------------------------------- |
| Node   | `pnpm digest <command>`                           |
| Built  | `node dist/cli.js <command>` (after `pnpm build`) |
| Docker | `docker compose run --rm digest <command>`        |

The global option `-c, --config <path>` (default `digest.config.json`) goes before the command.

## Onboarding, in order

Work through these with the user. Stop at the first red line and use the linked runbook.

1. **Machine check.** Node 24 or newer (or Docker Compose 2.24 or newer) and Ollama 0.40.0 or
   newer. RAM and disk: `docs/overview/cost-and-hardware.md`.
2. **Install.** `docs/runbooks/set-up/install-with-node.md` or `install-with-compose.md`.
3. **Config.** `pnpm digest init` asks for focus areas, profile and delivery and writes
   `digest.config.json` and `.env`. `init --yes` takes the defaults (profile `light`).
4. **Models.** `docs/runbooks/set-up/choose-profile-and-pull-models.md`. `doctor` prints the
   exact `ollama pull` line for each missing model.
5. **Health.** `pnpm digest doctor`. Every line must be `✓` or an accepted `!`. Fix each `✗`
   from its `fix:` line.
6. **First dry run.** `pnpm digest run --dry-run`. It must exit 0 and write `<week>.md` and
   `<week>.html` to `dist/digests` (Docker: `data/digests`).
   Details: `docs/runbooks/set-up/first-run.md`.
7. **Schedule.** Only after step 6 works: `docs/runbooks/set-up/schedule-weekly-runs.md`.

## Commands

| Command                                                                   | Use it to                                          |
| ------------------------------------------------------------------------- | -------------------------------------------------- |
| `init [-y]`                                                               | Write the config and `.env`                        |
| `doctor [--readiness]`                                                    | Check everything; `--readiness` rates each profile |
| `run [--since <window>] [--dry-run] [--force] [--seed <n>] [--out <dir>]` | One full run                                       |
| `eval [--profile <name>] [--only <section>] [--resume]`                   | Replay the eval set, print and save a scorecard    |
| `eval --compare <a.json> <b.json>`                                        | Compare two saved scorecards; runs nothing         |
| `fetch [--source <id...>] [--since <window>] [--out <dir>]`               | Fetch feeds only, no models                        |
| `show <week> [--part <name>] [--json]`                                    | Print a saved run                                  |
| `preview <week> [--channel <name>] [--out <dir>]`                         | Render a week for each channel, send nothing       |
| `history [-n, --limit <count>]`                                           | List past runs                                     |
| `feedback <week>`                                                         | Turn ticks in `review.md` into eval labels         |
| `serve`                                                                   | Run the weekly scheduler in the foreground         |

Full detail: `docs/reference/cli-commands.md`. Week ids look like `2026-W43`.

## Exit codes and statuses

`0` sent, dry-run or skipped. `1` failed. `2` blocked (every draft rejected and no fallback
digest could be made, rare). `3` quiet (nothing worth sending). When every draft is rejected the
run sends a fallback digest instead and exits 0: look for `fallback` in `digest history`. Start any
non-`sent` run at `docs/operations/triage.md`.

## Route the question

Find the user's intent, open the runbook, follow its steps, and quote its verify step.

| The user asks how to...                               | Runbook (in `docs/runbooks/`)                                                      |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------- |
| install with Docker or Node                           | `set-up/install-with-compose.md`, `set-up/install-with-node.md`                    |
| pick a profile, pull models                           | `set-up/choose-profile-and-pull-models.md`                                         |
| schedule weekly runs                                  | `set-up/schedule-weekly-runs.md`                                                   |
| add, change or remove a feed                          | `configure/add-a-source.md`, `update-a-source.md`, `remove-or-disable-a-source.md` |
| change the topics                                     | `configure/change-focus-areas.md`                                                  |
| turn a guard on or off, change its mode               | `configure/turn-a-guard-on-or-off.md`, `change-guard-mode.md`                      |
| change models or writers, set the judge               | `configure/change-models-or-writers.md`, `set-the-judge.md`                        |
| change thresholds                                     | `configure/change-thresholds.md`                                                   |
| set up email or Slack                                 | `configure/set-up-email.md`, `set-up-slack.md`                                     |
| change the output folder                              | `configure/change-the-output-folder.md`                                            |
| change the schedule or time zone                      | `configure/change-the-schedule-and-time-zone.md`                                   |
| set the seed or temperature                           | `configure/set-seed-and-temperature.md`                                            |
| change timeouts and retries                           | `configure/change-timeouts-and-retries.md`                                         |
| run now, dry run, force a week                        | `run/run-now.md`, `run/dry-run.md`, `run/force-a-week.md`                          |
| run the evals                                         | `run/run-evals.md`                                                                 |
| preview a week, fetch feeds only                      | `run/preview-a-week.md`, `run/fetch-sources-only.md`                               |
| read logs, follow a run, see traces                   | `observe/read-logs.md`, `follow-one-run.md`, `view-traces-in-jaeger.md`            |
| see history or one week                               | `observe/view-run-history.md`, `observe/show-a-week.md`                            |
| a run failed                                          | `debug/failed-run.md`                                                              |
| every draft was rejected (fallback digest, or exit 2) | `debug/blocked-run.md`                                                             |
| the week was quiet (exit 3)                           | `debug/quiet-week.md`                                                              |
| a feed fails                                          | `debug/failing-feed.md`                                                            |
| the model is slow or memory runs out                  | `debug/slow-model-or-out-of-memory.md`                                             |
| "Another run is in progress"                          | `debug/stuck-lock.md`                                                              |
| email or Slack did not arrive                         | `debug/failed-delivery.md`                                                         |
| an item is missing or wrong                           | `debug/missing-or-wrong-item.md`                                                   |
| finish a partly delivered week                        | `recover/resume-partial-delivery.md`                                               |
| run a week again                                      | `recover/re-run-a-week.md`                                                         |
| upgrade models, free disk, rotate secrets             | `maintain/upgrade-models.md`, `prune-disk.md`, `rotate-secrets.md`                 |
| re-baseline the evals, add a case from a bad week     | `maintain/re-baseline-evals.md`, `add-eval-case-from-a-bad-week.md`                |
| cut a release                                         | `release/cut-a-release.md`                                                         |

Questions about meaning, not tasks:

| The user asks about...           | Page (in `docs/`)                                     |
| -------------------------------- | ----------------------------------------------------- |
| how it works, the pipeline order | `architecture/data-flow.md`                           |
| ports and adapters               | `architecture/ports-and-adapters.md`                  |
| a setting                        | `configuration/README.md`, `reference/config-keys.md` |
| a metric or a gate               | `evaluation/README.md`, `evaluation/gates.md`         |
| current quality numbers          | `evaluation/results.md`                               |
| a term                           | `reference/glossary.md`                               |
| limits                           | `operations/known-limits.md`                          |

If no runbook fits, say so, answer from the reference pages, and suggest adding a runbook.
