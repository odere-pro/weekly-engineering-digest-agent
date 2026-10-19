# Set up email

Part of [Runbooks](../README.md) / [Configure](README.md).

## Purpose

Send the weekly digest, and failure notes, by email through your own SMTP server. The Markdown
files are still written; email is an extra channel.

## When to use

- You want the digest in an inbox as well as on disk.
- For Slack use [Set up Slack](set-up-slack.md). For the file folder use
  [Change the output folder](change-the-output-folder.md).
- An email that fails after setup: [Failed delivery](../debug/failed-delivery.md).

## Prerequisites

- SMTP host, port, user name, password, and the TLS mode of the server.
- A sender address and one or more recipient addresses.
- Write access to `digest.config.json` and to `.env` in the folder you run `digest` from. The
  loader always reads `./.env`, even when `-c` points at another config.

## Steps

1. Put the password in `.env`, never in the config. Quote it if it holds `#` or spaces, because an
   unquoted value ends at the first `#`.

   ```text
   SMTP_PASSWORD="change-me"
   ```

   Then run `chmod 600 .env`. In Docker, edit the `.env` on the host: it is mounted into the
   container.

2. Add `delivery.email` to `digest.config.json`. The block being present is what turns email
   on; there is no `enabled` key.

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

   | Key                           | Rule                                                                                                                            |
   | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
   | `delivery.email.host`, `user` | Required, not empty                                                                                                             |
   | `delivery.email.port`         | 1 to 65535, default 587                                                                                                         |
   | `delivery.email.secure`       | Default `false`. `true` means TLS from the first byte, usually port 465                                                         |
   | `delivery.email.requireTLS`   | Default `true`: refuse to send the password unless the server upgrades to TLS (STARTTLS). `false` only for a local mail catcher |
   | `delivery.email.from`         | A valid address                                                                                                                 |
   | `delivery.email.to`           | At least one valid address                                                                                                      |

   For a first test, list only your own address in `to`.

3. Apply the change. `digest serve` reads config and `.env` once, at start. In Docker:
   `docker compose restart digest`. A manual `pnpm digest run` and a host timer read them again
   each time. In Docker, other commands are `docker compose run --rm digest <command>`.
4. Check the setup and look at the mail without sending it.

   ```bash
   pnpm digest doctor
   ```

   ```bash
   pnpm digest preview 2026-W42 --channel email
   ```

   The preview writes `email.html` and `email.txt` under `dist/2026-10-12/digest/preview/`. Use a week that
   has a saved run.

5. Send for real. No command sends a test mail; the connection is first used in a run. If the
   week has no sent digest, `pnpm digest run` sends to every channel. If it was sent already,
   `--force` sends a second digest everywhere ([Force a week](../run/force-a-week.md)).

## Verify

- Doctor prints `✓ email: SMTP_PASSWORD is set (2 recipient(s) via smtp.example.com)`. That
  proves the password exists, not that the server accepts it.
- After the run, `pnpm digest show <week>` prints `Delivered:  markdown, email`.

## Roll back

Delete the whole `delivery.email` block and restart as in step 3. Remove `SMTP_PASSWORD` from
`.env` if you like. A password without a block is harmless; a block without a password stops
every run at start.

## Troubleshooting

| Symptom                                                               | Cause                               | Fix                                                                                               |
| --------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------- |
| `email delivery is configured but SMTP_PASSWORD is not set`           | Password missing from `.env`        | Add `SMTP_PASSWORD=...` to `.env`                                                                 |
| `Invalid email address` at `delivery.email.from`                      | Not an address                      | Use `name@example.com`                                                                            |
| `! .env values: SMTP_PASSWORD (line 2): the unquoted value has a "#"` | The password was cut at `#`         | Put the value in quotes                                                                           |
| `Delivery failed on email (SMTP delivery failed: ...)`                | Wrong host, port, TLS mode or login | Match `secure` and `requireTLS` to the server; see [Failed delivery](../debug/failed-delivery.md) |
| The digest went to the files only                                     | `serve` still runs the old config   | Restart as in step 3                                                                              |

## Related

- [Email delivery](../../configuration/delivery-email.md), [Environment](../../configuration/environment.md)
- [Delivery retries](../../operations/delivery-retries.md): 2 retries after 5 s and 10 s, only
  when nothing was sent. Timeouts are fixed (connect 15 s, greeting 15 s, socket 30 s).
- [Resume a partial delivery](../recover/resume-partial-delivery.md), [Rotate secrets](../maintain/rotate-secrets.md)
- [src/delivery/CLAUDE.md](../../../src/delivery/CLAUDE.md)
