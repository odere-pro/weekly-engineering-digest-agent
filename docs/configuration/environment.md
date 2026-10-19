# Environment and .env

Part of [Configuration](README.md).

Secrets and a few machine settings do not belong in `digest.config.json`. They come from the
environment: the `.env` file, or variables set in the shell. This page covers how they are read.
The full list with types is in the
[environment variables reference](../reference/environment-variables.md).

## Where values come from

- The file is `.env` in the folder you run `digest` from. The global `-c` option moves the config
  file only, not `.env`. In Docker the file is bind-mounted at `/app/.env`.
- The process environment is read too, and **it wins** over `.env` for the same name.
- An empty value counts as not set, in both places.
- Commands read both when they start. `serve` reads them once, so restart it after a change.
- `digest init` writes `.env` with mode 600. It never replaces an existing file: it adds the keys
  it needs, keeps your other keys, comments and line endings, and stops without writing if it
  cannot merge safely. It sets `OLLAMA_URL` only when the file has none.

## Secrets

| Variable            | Needed when              | Rule                                         |
| ------------------- | ------------------------ | -------------------------------------------- |
| `SMTP_PASSWORD`     | `delivery.email` is set  | Not empty                                    |
| `SLACK_WEBHOOK_URL` | `delivery.slack.enabled` | An `https` URL                               |
| `GITHUB_TOKEN`      | optional                 | Raises GitHub rate limits; uses the REST API |

Secrets never reach logs, run records, traces, error messages or the screen. Error messages name a
variable, never its value.

## Other settings

| Variable                      | Default                  | Meaning                                              |
| ----------------------------- | ------------------------ | ---------------------------------------------------- |
| `OLLAMA_URL`                  | `http://localhost:11434` | Where Ollama answers. Never `localhost` in Docker    |
| `LOG_LEVEL`                   | `info`                   | `debug`, `info`, `warn` or `error`                   |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset (no traces)        | A URL such as `http://jaeger:4318/v1/traces`         |
| `DIGEST_HOST_OS`              | this machine's OS        | OS of the machine Ollama runs on, for profile choice |
| `DIGEST_HOST_ARCH`            | this machine's CPU       | CPU of that machine                                  |
| `EVAL_JUDGE`                  | unset                    | Model tag `digest eval` uses to score digests        |

Host detection and the two `DIGEST_HOST_*` values are explained in [profiles](profiles.md).
`EVAL_JUDGE` is explained in [judge](judge.md).

## The hash caveat

An unquoted value in `.env` ends at its first `#`, the way Node's parser reads it. This line is
read as `pa`:

```text
SMTP_PASSWORD=pa#ss
```

Quote the value when it holds a `#`:

```text
SMTP_PASSWORD="pa#ss"
```

`digest doctor` warns about it by key and line number (`.env values`), and never prints a value.

## File permissions

Keep `.env` private: `chmod 600 .env`. `digest doctor` warns when other users can read it
(`.env: readable by other users (mode 644)`). On Linux with Docker the container user must still
read a mode 600 file, so set `DIGEST_UID` and `DIGEST_GID` to your own ids (`id -u`, `id -g`).

## Only for Docker

| Variable                   | Read by | Meaning                                                     |
| -------------------------- | ------- | ----------------------------------------------------------- |
| `DIGEST_UID`, `DIGEST_GID` | Compose | User and group of the container, default 1000               |
| `TZ`                       | Compose | Time zone inside the container, default `UTC`               |
| `REFRESH_MODELS`           | Compose | Set to `1` to make `model-pull` pull models already present |
| `COMPOSE_PROFILES`         | Compose | For example `linux`, to add the bundled Ollama              |

Compose reads `.env` to fill these, and passes `OLLAMA_URL` (default `http://ollama:11434`), `TZ`,
`DIGEST_HOST_OS`, `DIGEST_HOST_ARCH` and `OTEL_EXPORTER_OTLP_ENDPOINT` into the container. Those
then win over the mounted `.env`. Change one in `.env` and run `docker compose up -d` to recreate
the container. There is no `env_file`, so secrets stay out of `docker inspect`.

## Change it

- [Set up email](../runbooks/configure/set-up-email.md) and [set up Slack](../runbooks/configure/set-up-slack.md)
- [Rotate secrets](../runbooks/maintain/rotate-secrets.md)
- [Install with Compose](../runbooks/set-up/install-with-compose.md)

## Related

- [Environment variables reference](../reference/environment-variables.md)
- [Config file](config-file.md)
- [Read logs](../runbooks/observe/read-logs.md) and [view traces in Jaeger](../runbooks/observe/view-traces-in-jaeger.md)
