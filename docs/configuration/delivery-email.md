# Email delivery

Part of [Configuration](README.md).

The email channel sends the digest, and any failure note, to a fixed list of people through your
own SMTP server. It is off until you add a `delivery.email` object. The password is a secret and
lives in `.env`.

## Keys

| Key                         | Type             | Default  | Limits                               |
| --------------------------- | ---------------- | -------- | ------------------------------------ |
| `delivery.email.host`       | string           | required | not empty                            |
| `delivery.email.port`       | integer          | 587      | 1 to 65535                           |
| `delivery.email.secure`     | boolean          | `false`  | `true` means TLS from the first byte |
| `delivery.email.requireTLS` | boolean          | `true`   | refuse to send the login without TLS |
| `delivery.email.user`       | string           | required | not empty                            |
| `delivery.email.from`       | string           | required | a valid email address                |
| `delivery.email.to`         | array of strings | required | at least 1, each a valid address     |

```json
{
  "delivery": {
    "email": {
      "host": "smtp.example.com",
      "port": 587,
      "secure": false,
      "requireTLS": true,
      "user": "digest@example.com",
      "from": "digest@example.com",
      "to": ["alice@example.com", "bob@example.com"]
    }
  }
}
```

And in `.env`, never in the config file:

```text
SMTP_PASSWORD=your-smtp-password
```

Quote a password that contains `#`: an unquoted value ends at the first `#`
([environment](environment.md#the-hash-caveat)).

## TLS

| Setup                               | Meaning                                                           |
| ----------------------------------- | ----------------------------------------------------------------- |
| `secure: false`, `requireTLS: true` | Connect in clear, then require STARTTLS before the login. Default |
| `secure: true`                      | TLS from the first byte, usually port 465                         |
| `requireTLS: false`                 | Allow a login without TLS. Only for a local mail catcher          |

`digest init` asks "Use implicit TLS" and defaults to yes when you enter port 465.

## What is sent

- A digest mail has a text part and an HTML part. The subject is
  `Engineering digest <week>: <headline>`, cut to a safe length.
- A failure note is a short plain text mail titled `Weekly digest <week> failed at <step>`.
  `failed` and `blocked` runs send one, and so does a `quiet` run when nothing was collected. A dry
  run sends none. The title says "failed" for all of them.
- Recipients come only from `delivery.email.to`. A model can never add one.
- Text from feeds and models is put on one line, and invisible characters (a bidi mark or
  override, a zero-width space, a tag character) become a space, so a feed cannot reorder or hide
  what you read. A joiner between emoji stays. Slack uses the same rule, and so does the plain-text
  mail sent without a layout and the reason in a failure mail.
- Timeouts: 15 s to connect, 15 s for the greeting, 30 s of socket silence.
- A send is retried twice (after 5 s and 10 s), only when nothing could have been sent: a connect
  failure or connect timeout, or an SMTP 421, 450 or 451. A message can still arrive twice
  after a reset. See [delivery retries](../operations/delivery-retries.md).

## Turn it on or off

There is no `enabled` flag. The channel exists when `delivery.email` exists. Remove the object to
turn email off. If the object is there and `SMTP_PASSWORD` is missing, every run stops at start-up
with `email delivery is configured but SMTP_PASSWORD is not set. Add SMTP_PASSWORD to .env.` and
`digest doctor` reports an error.

Preview the mail without sending: `pnpm digest preview 2026-W42 --channel email` writes
`email.html` and `email.txt` under `dist/2026-10-12/digest/preview/`.

## Change it

- [Set up email](../runbooks/configure/set-up-email.md)
- [Rotate secrets](../runbooks/maintain/rotate-secrets.md)
- [Failed delivery](../runbooks/debug/failed-delivery.md)

## Related

- [Delivery feature](../features/delivery.md)
- [Markdown delivery](delivery-markdown.md) and [Slack delivery](delivery-slack.md)
- [Environment](environment.md)
