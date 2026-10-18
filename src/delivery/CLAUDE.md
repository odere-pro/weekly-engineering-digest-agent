# Delivery

## Intent

The weekly digest has to reach people: a file on disk, an email, a Slack message. The `Delivery`
port lets the pipeline hand over one finished digest, or one failure note, without knowing which
channel carries it. Each adapter turns the same `DigestMessage` into what its channel needs and
keeps secrets and untrusted text out of the result.

## How it works

1. The pipeline builds a `DigestMessage` (`weekId`, `subject`, `markdown`, and the laid-out
   `view` from `render/layout`) and calls `sendDigest` on every configured channel. On a failed
   run it calls `sendFailure` with a `FailureNote`.
2. `createMarkdownFileDelivery({ dir })` writes `<weekId>.md`, and `<weekId>.html` when there is a
   view. A failure goes to `<weekId>.failed.md`. This channel is always on.
3. `createSmtpDelivery(options)` sends through nodemailer. With a view it sends text plus HTML
   (`renderEmailText`, `renderEmailHtml`); without one, the Markdown as text.
4. `createSlackDelivery({ webhookUrl })` posts to the webhook. With a view it sends Block Kit
   (`toSlackBlocks`); otherwise `toSlackMrkdwn(markdown)`. Failures are one line (`failureOneLiner`).
5. A failed send throws a `DeliveryError`. `app/container` wraps each channel with retry and
   redaction decorators; those live in `src/app/`, not here.

## Design

- The core builds the view once. Channels only render it, so the three channels agree.
- Recipients, webhook and folder come from config and `.env` only, never from model output.
- Every model or collected string is made safe per channel: put on one line, HTML-escaped (email),
  `& < >` escaped (Slack, so `<!channel>` cannot appear). Only http(s) URLs without a user name or
  password become links.
- Email HTML has inline styles only: no script, style block, remote image or font.
- Slack limits are respected: 50 blocks, 3,000 chars per section, 150 chars for the header. When
  items do not fit, the last block says some are not shown.
- SMTP: STARTTLS is required by default (`requireTLS`), connect 15 s, greeting 15 s, socket 30 s,
  at least one recipient, recipients copied at creation.
- Slack: https only, 15 s timeout, `redirect: 'error'`. The webhook path is the secret, so the body
  is redacted before it is sent.
- Errors are built with `redactedError`: a copy of the cause chain (at most 5 levels) with every
  secret replaced, never the original error. Retry facts (`code`, `originalCode`, `status`,
  `responseCode`, `timeoutType`) are plain identifiers or integers on `DeliveryError`. The retry
  rule in `app/retryingDelivery` reads these facts, never the message text.
- Markdown channel: the week id is checked against `WEEK_ID_PATTERN` because it becomes a file
  name. Files are written atomically; the old `.html` is removed first so the two never disagree.

## Files

| File                        | Role                                                                                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Delivery.ts`               | The port, `DigestMessage`, `FailureNote`, `DigestView` types                                                                                               |
| `adapters/markdownFile.ts`  | Always-on file channel, `digestFilePaths`                                                                                                                  |
| `adapters/smtp.ts`          | Email through nodemailer (`MailTransport` is injectable)                                                                                                   |
| `adapters/slack.ts`         | Slack incoming webhook                                                                                                                                     |
| `adapters/emailRender.ts`   | `renderEmailText` and `renderEmailHtml` from a view                                                                                                        |
| `adapters/slackBlocks.ts`   | `toSlackBlocks`: view to Block Kit, with Slack limits                                                                                                      |
| `adapters/slackFormat.ts`   | `escapeSlack`, `toSlackMrkdwn` for Markdown without a view                                                                                                 |
| `adapters/failureNote.ts`   | `failureTitle` and `failureOneLiner`                                                                                                                       |
| `adapters/deliveryError.ts` | `DeliveryError`, `deliveryFacts`, `describeError`                                                                                                          |
| `adapters/redact.ts`        | `redactSecrets`, `redactedError`                                                                                                                           |
| `adapters/*.test.ts`        | Tests for each adapter (`deliveryError.ts` is covered in `redact.test.ts`), plus `smtp.mime.test.ts`, `markdownFile.html.test.ts`, `deliveryRetry.test.ts` |
| `adapters/__fixtures__/`    | `email/` golden text and HTML, `slack/` approved view and blocks                                                                                           |

## Depends on, used by

Depends on: `domain/schemas` (`Urgency`, `WEEK_ID_PATTERN`), `shared` (`errors`, `text`),
`store/adapters/atomicFile` (markdownFile), `nodemailer` (smtp only).
Used by: `digest` (`runDigest`, `runEnding`, `runResume`), `render`, `app` (container, redacting,
retryingDelivery), `cli/run`, `cli/preview`, `evals/metrics.ts`, `test/fakes/CapturingDelivery.ts`.

## Change it safely

- Run `pnpm vitest run src/delivery`. No network: fakes stand in for fetch and the mail transport.
- Email layout: edit `emailRender.ts`, run the tests with `UPDATE_GOLDEN=1` to rewrite the golden
  files, then read the diff. The Slack golden (`digest-blocks.json`) is edited by hand.
- `deliveryRetry.test.ts` imports `app/retryingDelivery`. Change the error facts and the retry rule
  together.
- Never put the original error in a `cause` or a message. Use `redactedError`.
- Never add the webhook URL or password to any message, log or note.
- A new channel needs its id in the `Delivery.id` union, in `DeliveryIdSchema` (`domain/schemas`)
  and in `config/schema.ts`. Some of these are frozen files: ask the coordinator.
- A message can still be sent twice if the server accepted it and then answered 429, 5xx or an
  SMTP 421, 450 or 451. That is a known limit of the retry rule.
