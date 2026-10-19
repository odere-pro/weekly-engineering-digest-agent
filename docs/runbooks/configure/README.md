# Configure

Part of [Runbooks](../README.md).

Runbooks that change how the digest behaves. Every one of them is an edit to
`digest.config.json` (settings) or `.env` (secrets), plus a check that it worked.

| Runbook                                                                   | Use it to                                                                   |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [Add a source](add-a-source.md)                                           | Collect from one more RSS/Atom feed or GitHub repository                    |
| [Update a source](update-a-source.md)                                     | Change a source's URL, id, kind, `area` hint or item cap                    |
| [Remove or disable a source](remove-or-disable-a-source.md)               | Stop collecting from a source (there is no disabled flag, so you remove it) |
| [Change focus areas](change-focus-areas.md)                               | Change the topics the classifier, writers and judge care about              |
| [Turn a guard on or off](turn-a-guard-on-or-off.md)                       | Switch one safety check, or a whole group of them, on or off                |
| [Change guard mode](change-guard-mode.md)                                 | Choose between "block on any flag" and "block only if all guards flag"      |
| [Change models or writers](change-models-or-writers.md)                   | Pick another profile or replace the writer panel with your own tags         |
| [Set the judge](set-the-judge.md)                                         | Turn the judge on or off by changing the writer panel size                  |
| [Change thresholds](change-thresholds.md)                                 | Move the relevance, hype, minor-release and guard cut-offs                  |
| [Set up email](set-up-email.md)                                           | Send the digest by SMTP, with the password in `.env`                        |
| [Set up Slack](set-up-slack.md)                                           | Post the digest to a Slack channel through a webhook in `.env`              |
| [Change the output folder](change-the-output-folder.md)                   | Choose where `<week>.md` and `<week>.html` are written                      |
| [Change the schedule and time zone](change-the-schedule-and-time-zone.md) | Change the day, hour and zone of the weekly run and of the ISO week         |
| [Set seed and temperature](set-seed-and-temperature.md)                   | Make reruns repeat, or make the writers more or less varied                 |
| [Change timeouts and retries](change-timeouts-and-retries.md)             | Give slow models more time, or change how often a model call is retried     |

## Rules that hold for all of them

- **Restart `serve`.** `digest serve` reads the config and `.env` once, when it starts. After an
  edit, restart it (Docker: `docker compose restart digest`). A manual `pnpm digest run` and a
  host timer start a new process each time and read the files again.
- **A typo is not an error.** Most objects in `digest.config.json` drop keys they do not know
  without a message, so a misspelled key (or a `"disabled": true` on a source) has no effect.
  The exception is the role names under `models.timeoutsMs`, `models.think` and
  `models.temperature`, which are rejected when unknown. Check spelling against
  [Config keys](../../reference/config-keys.md).
- **Check first, then run.** `pnpm digest doctor` loads both files and names the field that is
  wrong. It does not check the schedule.
- **Secrets stay in `.env`.** That is `SMTP_PASSWORD`, `SLACK_WEBHOOK_URL` and `GITHUB_TOKEN`.
  The loader reads `./.env` from the folder you run `digest` in, even when `-c` points elsewhere.
- **Docker.** Run commands as `docker compose run --rm digest <command>`. On a Mac,
  `make docker-init` and `make docker-up` wrap init and up.
- **`digest init` is not an editor.** It refuses to overwrite a config (`--yes`) or asks first,
  and would rewrite your sources. Edit the file by hand.

Related: [Config keys](../../reference/config-keys.md), [Configuration](../../configuration/README.md),
[First run](../set-up/first-run.md).
