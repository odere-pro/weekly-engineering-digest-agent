# App

Part of [Features](README.md).

## What it is for

The pipeline knows only ports. Something has to pick the real adapters, hand them their config and
secrets, and make sure no secret leaks on the way. That is this feature: the composition root. The
CLI, the scheduler and the evals call it once and get a ready set of dependencies.

## Where it sits

It sits between the commands and the adapters. Commands call it, it builds the adapters, and the
pipeline uses them through ports. See [ports and adapters](../architecture/ports-and-adapters.md).

## What it does

- Takes the loaded config and returns the ready pipeline dependencies and a `close` function.
  Every failure is a rejection, so callers have one error path.
- Builds the delivery channels first, before anything starts. The Markdown file channel is always
  there. Email is added when `delivery.email` is set and Slack when `delivery.slack.enabled` is
  true. A missing `SMTP_PASSWORD` or `SLACK_WEBHOOK_URL` stops the start with an error that names
  the variable.
- Builds the Ollama model provider, the RSS and GitHub fetchers (a `GITHUB_TOKEN` switches GitHub
  sources to the REST API), the four guards and the file run store.
- Wraps every delivery channel with retry (2 retries, after 5 s then 10 s, only when sending again
  cannot double the message) and with secret redaction. Redaction wraps the retry, so each retry
  sends the same cleaned message.
- Wraps the run store so secrets are removed from every artifact and run record before they reach
  disk. A record that no longer fits its schema after redaction is not saved.
- Gives log lines the right `runId` and `step`, even though the model, fetchers and guards are built
  once and `digest serve` runs many weeks. The model calls get spans with the role and the model
  (token counts too), never a prompt or an answer.
- Builds the tracer last, so a failed start never leaves a tracer registered. `close()` flushes
  the traces and only logs a failure.
- Redaction covers the three declared secrets and the Slack webhook path. It does not cover a
  password you put inside `OLLAMA_URL` or the trace endpoint.

## What you can configure

- Nothing of its own. It reads the loaded config and `.env`: the delivery settings, `profile`,
  `models.*`, `dataDir`, `LOG_LEVEL` and `OTEL_EXPORTER_OTLP_ENDPOINT`.
- Which channels exist is decided by the delivery settings. See
  [email delivery](../configuration/delivery-email.md) and
  [Slack delivery](../configuration/delivery-slack.md).
- The app is built once per process. After a config change, restart `digest serve`. See
  [stopping and restarts](../operations/stopping-and-restarts.md).
- Variables: [environment](../configuration/environment.md).

## What can go wrong

- The start stops with "email delivery is configured but SMTP_PASSWORD is not set" (or the same
  for `SLACK_WEBHOOK_URL` and Slack delivery). Add the variable to `.env`. See
  [set up email](../runbooks/configure/set-up-email.md),
  [set up Slack](../runbooks/configure/set-up-slack.md) and
  [rotate secrets](../runbooks/maintain/rotate-secrets.md).
- A transient delivery failure is retried. A longer outage is the scheduler's job. See
  [delivery retries](../operations/delivery-retries.md).
- A secret you suspect in a log or record: it should not appear, because of the layers above.
  Report it as a bug and rotate the secret. See [safety](../architecture/safety.md).

## Code and tests

- Folder: [src/app/](../../src/app/). Maintainer notes: [CLAUDE.md](../../src/app/CLAUDE.md).
- No port of its own. It is the one place that imports the adapters of every port.
- Tests sit next to the code. They wrap each factory with a spy that still builds the real
  adapter, then check the options it got, and they test that a secret reaches no log or record.
  Some scheduler tests also live here, for historic reasons.

## Related

- Callers: [cli](cli.md), [scheduler](scheduler.md) and [evals](evals.md).
- Built from: [config](config.md), [models](models.md), [guards](guards.md), [sources](sources.md),
  [delivery](delivery.md), [store](store.md), [observability](observability.md).
- [Deployment](../architecture/deployment.md) shows how the app runs under Docker.
