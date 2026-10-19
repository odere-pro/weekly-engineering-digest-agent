# Set up Slack

Part of [Runbooks](../README.md) / [Configure](README.md).

## Purpose

Post the weekly digest, and failure notes, to a Slack channel through an incoming webhook. The
Markdown files are still written; Slack is an extra channel.

## When to use

- Your team reads the digest in Slack.
- For email use [Set up email](set-up-email.md). A Slack post that fails after setup:
  [Failed delivery](../debug/failed-delivery.md).

## Prerequisites

- A Slack incoming webhook URL for the target channel. Your Slack admin may need to approve it.
  Treat the URL like a password: anyone who has it can post in that channel.
- Write access to `digest.config.json` and to `.env` in the folder you run `digest` from.

## Steps

1. Put the webhook in `.env`. It must start with `https://`. The loader refuses `http://`.

   ```text
   SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T000/B000/XXXX
   ```

   Then run `chmod 600 .env`. In Docker, edit the `.env` on the host: it is mounted into the
   container.

2. Turn Slack on in `digest.config.json`. Only the switch lives in the config.

   ```json
   {
     "delivery": {
       "slack": { "enabled": true }
     }
   }
   ```

3. Apply the change. `digest serve` reads config and `.env` once, at start. In Docker:
   `docker compose restart digest`. A manual `pnpm digest run` and a host timer read them again
   each time. In Docker, other commands are `docker compose run --rm digest <command>`.
4. Check the setup, and look at the message without posting it.

   ```bash
   pnpm digest doctor
   ```

   ```bash
   pnpm digest preview 2026-W42 --channel slack
   ```

   The preview writes `slack.json` (the Block Kit payload) under `dist/preview/2026-W42/`. Use a
   week that has a saved run.

5. Post for real. No command posts a test message; the webhook is first used in a run. If the
   week has no sent digest, `pnpm digest run` posts to every channel. If it was sent already,
   `--force` posts again, and sends a second email too ([Force a week](../run/force-a-week.md)).

## Verify

- Doctor prints `✓ slack: SLACK_WEBHOOK_URL is set`. That proves the variable exists, not that
  Slack accepts the URL.
- After the run, `pnpm digest show <week>` prints `Delivered:  markdown, slack` (with the other
  channels you use) and the message is in the channel.

## Roll back

Set `"enabled": false` (or delete the `delivery.slack` block) and restart as in step 3. Remove
`SLACK_WEBHOOK_URL` from `.env` if the webhook is retired. With Slack off, the variable is not
needed.

## Troubleshooting

| Symptom                                                               | Cause                                                | Fix                                                                   |
| --------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------- |
| `Invalid URL` at `SLACK_WEBHOOK_URL` (Invalid environment)            | Not an `https://` URL                                | Copy the full webhook URL                                             |
| `Slack delivery is configured but SLACK_WEBHOOK_URL is not set`       | Variable missing from `.env`                         | Add it                                                                |
| `✗ slack: Slack delivery is enabled but SLACK_WEBHOOK_URL is not set` | The same, seen by doctor                             | Run the `fix:` line                                                   |
| `Slack webhook answered HTTP 404` (or 403)                            | The webhook was revoked or mistyped                  | Create a new one; see [Rotate secrets](../maintain/rotate-secrets.md) |
| `Delivery failed on slack (...)` and other channels delivered         | Slack down or network blocked                        | [Resume a partial delivery](../recover/resume-partial-delivery.md)    |
| Nothing posted, no error                                              | `enabled` is `false`, or `serve` runs the old config | Set `true`; restart                                                   |

## Related

- [Slack delivery](../../configuration/delivery-slack.md), [Environment](../../configuration/environment.md)
- [Delivery retries](../../operations/delivery-retries.md): an HTTP 429 or 5xx is retried twice,
  after 5 s and 10 s. The request times out after 15 s and a redirect counts as a failure.
- [src/delivery/CLAUDE.md](../../../src/delivery/CLAUDE.md)
