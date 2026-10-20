# Delivery

Part of [Features](README.md).

## What it is for

The weekly digest has to reach people: a file on disk, an email, a Slack message. The `Delivery`
port lets the pipeline hand over one finished digest, or one failure note, without knowing which
channel carries it. Each adapter turns the same message into what its channel needs and keeps
secrets and untrusted text out of the result.

## Where it sits

It is the last step, deliver, after select. See [data flow](../architecture/data-flow.md).

## What it does

- Sends the winning digest to every configured channel and tries all of them. One failing channel
  does not stop the others. The run records which channels got it (`deliveredTo` in `run.json`).
- Markdown file channel (always on): writes `<week>.md`, and `<week>.html` when it has a view.
  A failure note goes to `<week>.failed.md`. Files are written atomically, and the old `.html`
  is removed first so the two never disagree.
- Email (only when `delivery.email` is set): sends text plus HTML through SMTP. STARTTLS is required
  by default. Timeouts: connect 15 s, greeting 15 s, socket 30 s. The HTML uses inline styles
  only: no script, no remote image or font.
- Slack (only when `delivery.slack.enabled` is true): posts a Block Kit message to the webhook.
  Text is escaped so `<!channel>` cannot appear. It respects Slack's limits (50 blocks, 3,000
  characters per section); a final block says when items do not fit. The call is https only, with
  a 15 s timeout and no redirects.
- Retries a transient failure twice (after 5 s, then 10 s), but only when sending again cannot
  double the message: a connect failure, HTTP 429 or 5xx, or SMTP 421, 450 or 451. A reset after
  the body went out is not retried. A message can still arrive twice in the rare 429 or 5xx case.
- Sends a failure note, a short plain text, to every channel when a run fails (also when every
  source failed), is blocked, or ends `quiet` with nothing collected. An ordinary quiet week and a
  dry run send no note.
- Recipients, webhook and folder come from config and `.env` only, never from model output.
  Secrets are removed from every message and error before it leaves.

## What you can configure

- `delivery.markdown.dir` (no default: unset, the files go to the week's `digest/` folder in the
  data folder, `dist/<monday>/digest/`). See
  [Markdown delivery](../configuration/delivery-markdown.md).
- `delivery.email` (`host`, `port`, `secure`, `requireTLS`, `user`, `from`, `to`) and
  `SMTP_PASSWORD`. See [email delivery](../configuration/delivery-email.md) and
  [set up email](../runbooks/configure/set-up-email.md).
- `delivery.slack.enabled` and `SLACK_WEBHOOK_URL`. See [Slack delivery](../configuration/delivery-slack.md)
  and [set up Slack](../runbooks/configure/set-up-slack.md).
- The retry timing is fixed. All keys: [config keys](../reference/config-keys.md).

## What can go wrong

- A channel is down or misconfigured. The run fails at step `deliver`, but the channels that
  worked are recorded. See [failed delivery](../runbooks/debug/failed-delivery.md).
- Only some channels got the digest. The next `digest run` sends the saved `digest.md` to the
  missing ones. See [resume a partial delivery](../runbooks/recover/resume-partial-delivery.md).
- A missing `SMTP_PASSWORD` or `SLACK_WEBHOOK_URL` stops the start with an error naming the
  variable. See [rotate secrets](../runbooks/maintain/rotate-secrets.md).
- A digest can arrive twice after a timeout. See [delivery retries](../operations/delivery-retries.md).
- To check a channel's output without sending, use `pnpm digest preview <week>`. See
  [preview a week](../runbooks/run/preview-a-week.md).

## Code and tests

- Folder: [src/delivery/](../../src/delivery/). Maintainer notes: [CLAUDE.md](../../src/delivery/CLAUDE.md).
- Port: [Delivery.ts](../../src/delivery/Delivery.ts). Adapters:
  [src/delivery/adapters/](../../src/delivery/adapters/) (Markdown file, SMTP, Slack, and the email
  and Slack renderers).
- Tests sit next to the code. Fakes stand in for `fetch` and the mail transport, and golden files
  pin the email and Slack output.

## Related

- Before: [select](select.md). The text it sends comes from [render](render.md).
- [app](app.md) wraps each channel with retry and secret redaction.
- [digest](digest.md) decides which channels still need the digest after a failure.
