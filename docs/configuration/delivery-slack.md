# Slack delivery

Part of [Configuration](README.md).

The Slack channel posts the digest, and any failure note, to one channel through a Slack incoming
webhook. The config file only switches it on. The webhook URL is a secret and lives in `.env`.

## Keys

| Key                      | Type    | Default | Limits                                |
| ------------------------ | ------- | ------- | ------------------------------------- |
| `delivery.slack.enabled` | boolean | `false` | the `slack` object itself is optional |

```json
{
  "delivery": { "slack": { "enabled": true } }
}
```

And in `.env`:

```text
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T000/B000/XXXX
```

The URL must use `https`. Every command refuses a webhook with another scheme when it loads the
environment, and names the variable. The path of the URL is the secret. It never appears in logs, run records, error messages or traces.

## Turn it on or off

- On: `"slack": { "enabled": true }` plus `SLACK_WEBHOOK_URL` in `.env`.
- Off: remove the `slack` object, or set `enabled` to `false`. The webhook line can stay in `.env`.
- If Slack is on and the variable is missing, every run stops at start-up with
  `Slack delivery is configured but SLACK_WEBHOOK_URL is not set. Add SLACK_WEBHOOK_URL to .env.`
  `digest doctor` reports the same as an error.

## What is sent

- A Block Kit message built from the same layout as the email and the Markdown file: a header
  and the items grouped by urgency. Slack's limits are respected (50 blocks, 3,000 characters
  per section, 150 for the header). When items do not fit, the last block says some are not shown.
- Text from feeds and models is escaped, so `<!channel>` or a link trick in a feed cannot ping
  your channel.
- A failure note is one line: `Weekly digest <week> failed at <step>: <reason>`.
- The post times out after 15 s, and a redirect counts as a failure, so only the configured
  address is ever contacted. Any answer other than success fails the channel with
  `Slack webhook answered HTTP <status>`.
- A send is retried twice (after 5 s and 10 s) for a connect failure, HTTP 429 or a 5xx. Any other
  error fails the channel at once. A message can still arrive twice. See
  [delivery retries](../operations/delivery-retries.md).

Preview the message without posting it: `pnpm digest preview 2026-W42 --channel slack` writes
`slack.json` under `dist/preview/2026-W42/`.

## Change it

- [Set up Slack](../runbooks/configure/set-up-slack.md)
- [Rotate secrets](../runbooks/maintain/rotate-secrets.md) when the webhook leaks
- [Failed delivery](../runbooks/debug/failed-delivery.md)

## Related

- [Delivery feature](../features/delivery.md)
- [Markdown delivery](delivery-markdown.md) and [email delivery](delivery-email.md)
- [Environment](environment.md)
- [Safety](../architecture/safety.md)
