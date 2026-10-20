# First run

Part of [Runbooks](../README.md) / Set up.

## Purpose

Prove that a fresh install works end to end: Ollama, models, feeds and file output. A dry run
runs the whole pipeline and sends nothing. Do it before you schedule weekly runs.

## When to use

- Right after [Install with Node](install-with-node.md) or
  [Install with Docker Compose](install-with-compose.md), and after you
  [pull models](choose-profile-and-pull-models.md).
- To test a later change safely, use the [dry run](../run/dry-run.md) runbook instead.

## Prerequisites

- `digest.config.json` and `.env` exist (`digest init` wrote them).
- The models of your profile are pulled.
- Time: about 6 minutes for `light` on the reference laptop (340 s on average). `quality` is
  not measured end to end: its input guard alone took 65 minutes there. Docker prefix: `docker compose run --rm digest <command>`.

## Steps

1. Check this machine against every profile. It contacts only Ollama.

   ```bash
   pnpm digest doctor --readiness
   ```

   The `verdict` column reads `ready`, `tight on RAM`, `pull models` or `not for this machine`.
   `tight on RAM` is `quality` on 32 GiB up to 48 GiB: it runs, but swapped when measured, and a line
   under the table says how much. The command exits 0 when at least one profile can run here (it is
   `ready`, `tight on RAM` or needs only pulls), and 1 when none can.

2. Run the full check. It tests Ollama and its version, each model, every feed (10 s each), the
   delivery secrets, `.env` and the folders. Every line must be `✓`, or an accepted `!`.
   Fix every `✗` using the `fix:` line under it.

   ```bash
   pnpm digest doctor
   ```

3. Run the pipeline without sending anything.

   ```bash
   pnpm digest run --dry-run
   ```

   The summary looks like this (numbers differ):

   ```text
   Week      2026-W43
   Status    dry-run
   Items     131 collected → 5 in digest
   Winner    gemma4:e4b-mlx
   Duration  5m 40s
   Digest    dist/2026-10-19/digest/digest.md
   Markdown  dist/2026-10-19/digest/2026-W43.md
   HTML      dist/2026-10-19/digest/2026-W43.html
   Dry run: nothing was sent.
   ```

4. Open the `Markdown` file and read it. Then list the run:

   ```bash
   pnpm digest history -n 1
   ```

## Verify

- `run --dry-run` exits 0 and prints `Status    dry-run`.
- `<week>.md` and `<week>.html` exist in the week's folder, `dist/<monday>/digest/` (Node and
  Docker; `delivery.markdown.dir` moves them).
- `dist/<monday>/digest/` holds `run.json`, `items.json`, `scores.json`, `drafts.json`,
  `digest.md` and `review.md`. `dist/<monday>/<source>/raw/` holds what each source answered.
- A dry run does not test email or Slack. `doctor` only checks that `SMTP_PASSWORD` or
  `SLACK_WEBHOOK_URL` is set, not that the provider accepts it.

## Roll back

Nothing needs undoing. A dry run sends nothing and sends no failure note. Its run folder and
digest files stay; delete them if you want a clean start (`dist/<monday>/`).

A `dry-run` week is not `sent`. When you later start `digest serve`, it runs this week for real if
the Monday slot has already passed. See [schedule weekly runs](schedule-weekly-runs.md).

## Troubleshooting

| Symptom                                                                 | Cause                                                                            | Fix                                                                                    |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Exit 3, `Status    quiet`                                               | Nothing in the window, or fewer than 3 items qualified                           | Often fine. See [quiet week](../debug/quiet-week.md). Try `run --dry-run --since 14d`. |
| Exit 1, `Error (step: collect): every source failed (24 of 24 sources)` | The machine cannot reach any feed (no network or DNS)                            | See [failing feed](../debug/failing-feed.md).                                          |
| Exit 1, `Ollama is not reachable ... Start Ollama`                      | Ollama is down or `OLLAMA_URL` is wrong                                          | Start Ollama, then run `doctor`.                                                       |
| Exit 1, `Ollama is missing models for profile "light": ...`             | A model is not pulled                                                            | Run the `ollama pull` lines from `doctor`.                                             |
| Exit 1, `Another run is in progress`                                    | Another run holds `dist/digest.lock`                                             | Wait, or see [stuck lock](../debug/stuck-lock.md).                                     |
| Exit 2, `Status    blocked`                                             | Every draft failed a check or a guard, and the fallback digest could not be made | See [blocked run](../debug/blocked-run.md).                                            |
| `Error: could not write the dry-run digest to ...`                      | The digest folder is not writable                                                | Fix permissions, or pass `--out <dir>`.                                                |

## Related

- [Dry run](../run/dry-run.md), [Run now](../run/run-now.md), [Failed run](../debug/failed-run.md)
- [Exit codes](../../reference/exit-codes.md), [Files and paths](../../reference/files-and-paths.md)
- [Getting started](../../overview/getting-started.md)
