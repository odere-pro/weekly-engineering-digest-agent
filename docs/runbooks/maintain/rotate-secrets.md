# Rotate secrets

Part of [Runbooks](../README.md) / Maintain.

## Purpose

Replace the SMTP password, the Slack webhook URL or the GitHub token with new ones, without
leaking the old or the new value.

## When to use

- A secret expired, was exposed, or the person who held it left.
- A provider forced a new password or token.
- To set up email or Slack for the first time, use [Set up email](../configure/set-up-email.md)
  or [Set up Slack](../configure/set-up-slack.md).

## Prerequisites

- The three secrets live only in `.env` (or the process environment): `SMTP_PASSWORD` (needed when
  `delivery.email` is set), `SLACK_WEBHOOK_URL` (needed when Slack is on; must be `https:`) and
  `GITHUB_TOKEN` (optional; raises rate limits and switches GitHub sources to the REST API).
- A new value from the provider, already created. Keep the old one valid until step 6.
- **Never read or print values.** Do not `cat` or `grep` `.env`, and do not paste the file or
  `printenv` output into chat, tickets or logs. Edit it in an editor.
- Do not use `digest init` to rotate: it rewrites `digest.config.json` (after a prompt).

## Steps

1. Open `.env` in your editor and replace the value on the line you are rotating. Keep one
   `KEY=value` per line. If a value contains `#`, quote it (`SMTP_PASSWORD="pa#ss"`): an unquoted
   value ends at its first `#`.
2. Make sure the shell does not override the file. The process environment wins over `.env`. This
   prints only whether the variable is set, never its value:

   ```bash
   printenv SMTP_PASSWORD > /dev/null && echo "set in the shell: remove it"
   ```

3. Restrict the file.

   ```bash
   chmod 600 .env
   ```

4. Check the setup.

   ```bash
   pnpm digest doctor
   ```

5. Restart whatever reads `.env` at start. `digest serve` reads it once. Docker: recreate the
   container so it mounts the current file (a plain `restart` can keep an old copy if your editor
   replaced the file):

   ```bash
   docker compose up -d --force-recreate digest
   ```

   Linux: add `--profile linux`. Node: stop `serve` (it finishes a running digest first) and start
   it again. An OS timer needs nothing: each `digest run` reads the file.

6. Prove the new value works, then revoke the old one at the provider.
   - `GITHUB_TOKEN`: `pnpm digest fetch --source <a-github-source-id>` shows `ok` and `200`.
   - `SMTP_PASSWORD` and `SLACK_WEBHOOK_URL`: there is no test-send command and a dry run sends
     nothing. The proof is the next real delivery; see Verify.

## Verify

- `doctor` shows `✓ .env: readable only by you`, `✓ .env values: no unquoted value contains a "#"`
  and, for what you rotated, `✓ email: SMTP_PASSWORD is set (...)` or `✓ slack: SLACK_WEBHOOK_URL is set`.
  These check that a value exists, not that the provider accepts it.
- After the next run, `pnpm digest show <week>` has a `Delivered:` line with `email` or `slack`.
- No secret appears in `docker compose logs digest` or in `dist/<monday>/` (the run folder, the source data) or `dist/logs/`. The tool redacts
  known secrets there, which is a second line of defence, not a reason to be careless.

## Roll back

Put the previous value back in `.env` (from your password manager), repeat steps 3 to 5, and keep
the old secret valid at the provider until the new one works. If the new secret leaked, revoke it
and rotate again.

## Troubleshooting

| Symptom                                                            | Cause                                                    | Fix                                                        |
| ------------------------------------------------------------------ | -------------------------------------------------------- | ---------------------------------------------------------- |
| `email: email delivery is configured but SMTP_PASSWORD is not set` | The line is missing, empty or commented out              | Add `SMTP_PASSWORD=...` to `.env`.                         |
| `Invalid environment (.env and process environment): ...`          | A value is not valid, such as a non-`https:` webhook     | Fix the key named in the message (values are never shown). |
| `.env values: ... the unquoted value has a "#"`                    | `#` starts a comment in an unquoted value                | Quote the value, for example `KEY="pass#word"`.            |
| `.env: readable by other users (mode 644)`                         | Loose permissions                                        | `chmod 600 .env`.                                          |
| Email or Slack still fails with the old secret                     | `serve` was not restarted, or the shell overrides `.env` | Redo steps 2 and 5.                                        |
| The fetch table shows `HTTP 401` for a GitHub source               | The token is wrong or revoked                            | Create a new token and repeat step 1.                      |

## Related

- [Failed delivery](../debug/failed-delivery.md), [Environment variables](../../reference/environment-variables.md)
- [Environment](../../configuration/environment.md), [Safety](../../architecture/safety.md)
- [src/config/CLAUDE.md](../../../src/config/CLAUDE.md)
