# Debug a failed delivery

Part of [Runbooks](../README.md) / Debug.

## Purpose

Find out why the digest did not reach one channel (email or Slack), fix the cause, and send
the saved digest to the channels that missed it.

## When to use

- The week is `failed` and the error starts with `Delivery failed on`.
- People report that the email or the Slack message did not arrive, but the Markdown file
  exists.
- For any other `failed` message use [Debug a failed run](failed-run.md).

## Prerequisites

- Access to the machine, the config and `.env`. Secrets are never printed; read them from the
  file, not from the logs.
- Ollama does not need to run. Resuming a delivery makes no model call.

## Steps

1. Read the week. `Delivered:` lists the channels that got the digest. The `Error:` line names
   the ones that did not, with the reason.

   ```bash
   pnpm digest show 2026-W41
   ```

   ```text
   Delivered:  markdown
   Error:      Delivery failed on email (connect ECONNREFUSED 127.0.0.1:587); delivered on markdown (step deliver)
   ```

2. Run the checks. `doctor` confirms that `SMTP_PASSWORD` or `SLACK_WEBHOOK_URL` is set, that
   the digest folder is writable and that `.env` is private. It does not open a connection to
   the mail server or the webhook.

   ```bash
   pnpm digest doctor
   ```

3. Find the cause for the channel.

   | Channel  | Error shows                                | Cause and fix                                                                                 |
   | -------- | ------------------------------------------ | --------------------------------------------------------------------------------------------- |
   | email    | `ECONNREFUSED`, `ENOTFOUND`                | Wrong `delivery.email.host` or `delivery.email.port`                                          |
   | email    | an authentication error from the server    | Wrong `delivery.email.user` or `SMTP_PASSWORD`                                                |
   | email    | a TLS or STARTTLS error                    | The server must upgrade to TLS; check `delivery.email.secure` and `delivery.email.requireTLS` |
   | slack    | `Slack webhook answered HTTP 404` (or 4xx) | The webhook was revoked or is wrong; fix `SLACK_WEBHOOK_URL`                                  |
   | slack    | `Slack webhook answered HTTP 5xx`          | Slack is down; retry later                                                                    |
   | markdown | a file system error                        | The digest folder is not writable; see `doctor` line `markdown`                               |

   Email and Slack sends are retried twice (after 5 and 10 seconds), but only for a failure
   where nothing was sent: a connect failure, HTTP 429 or 5xx, or SMTP 421, 450 and 451.
   Any other error fails the channel at once.

4. Edit the config or `.env`. Restart `serve` so it reads them: `docker compose restart digest`.
   A one-shot `pnpm digest run` always reads them fresh.
5. Send what is missing. The run does not start over: it sends the saved `digest.md` to the
   channels that missed it and marks the week `sent`.

   ```bash
   pnpm digest run
   ```

   If this refuses with a message that contains `--force`, follow
   [Resume a partial delivery](../recover/resume-partial-delivery.md).

## Verify

`pnpm digest show 2026-W41` shows `Delivered:` with every configured channel and the status
`sent`. The log line `Digest delivered` lists the channels that took it now.

## Roll back

A sent message cannot be recalled. A resume sends only to the channels that missed it, so the
others get no second copy. If you must undo a config edit, restore the old value and restart
`serve`.

## Troubleshooting

| Symptom                                                     | Cause                                             | Fix                                          |
| ----------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------- |
| `email delivery is configured but SMTP_PASSWORD is not set` | The app cannot start without the secret           | Add `SMTP_PASSWORD` to `.env`                |
| Password with `#` fails to log in                           | An unquoted value ends at `#`                     | Quote it; `doctor` warns on `.env values`    |
| No failure note arrived on the broken channel               | The note uses the same channel                    | Read `<week>.failed.md` in the digest folder |
| A message arrived twice                                     | The server took it, then answered 429, 5xx or 421 | Known limit of at-least-once delivery        |

## Related

- [Delivery retries](../../operations/delivery-retries.md) and
  [Failed run](failed-run.md)
- [Set up email](../configure/set-up-email.md) and [Set up Slack](../configure/set-up-slack.md)
- [src/delivery/CLAUDE.md](../../../src/delivery/CLAUDE.md)
