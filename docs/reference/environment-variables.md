# Environment variables

Part of [Reference](README.md).

Every variable the agent, its Docker setup and its tests read. The program reads the first group
from `.env` and from the process environment (the process wins; empty means unset). How the
two sources combine is explained in [environment](../configuration/environment.md).

## Read by the program

These are defined in `SecretsSchema` and `EnvSchema` in `src/config/schema.ts`.

| Variable                      | Secret | Default                  | Meaning                                                                                                              |
| ----------------------------- | ------ | ------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `SMTP_PASSWORD`               | yes    | unset                    | Password for `delivery.email.user`. Needed when email is configured                                                  |
| `SLACK_WEBHOOK_URL`           | yes    | unset                    | Slack incoming webhook. Must be `https`. Needed when Slack is enabled                                                |
| `GITHUB_TOKEN`                | yes    | unset                    | Raises GitHub rate limits; GitHub sources then use the REST API                                                      |
| `OLLAMA_URL`                  | no     | `http://localhost:11434` | Where Ollama answers. Never `localhost` inside Docker                                                                |
| `LOG_LEVEL`                   | no     | `info`                   | `debug`, `info`, `warn` or `error`. Logs are JSON on stdout and in `<dataDir>/logs/<day>/digest.log`                 |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | no     | unset                    | A URL. When set, OpenTelemetry traces are exported there                                                             |
| `DIGEST_HOST_OS`              | no     | this process's OS        | OS of the machine Ollama runs on: `darwin`, `linux`, `windows` or `uname -s` spelling                                |
| `DIGEST_HOST_ARCH`            | no     | this process's CPU       | CPU of that machine: `arm64`, `aarch64`, `x86_64`, `x64`, `amd64`                                                    |
| `EVAL_JUDGE`                  | no     | unset                    | Model tag `digest eval` uses to score digests of a profile with no judge. Not the judge a `models.writers` list gets |

A bad value stops the command with `Invalid environment (...)` and names the variable, never the
value. `DIGEST_HOST_OS` and `DIGEST_HOST_ARCH` with other values stop it with
`Invalid DIGEST_HOST_OS "<value>": use darwin, linux or windows (as "uname" prints it).`

## Read by one command

| Variable        | Secret | Read by              | Meaning                                                                                                                                                           |
| --------------- | ------ | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OLLAMA_MODELS` | no     | `doctor --readiness` | Folder of Ollama's models, to report free disk. Read from the process environment only, and only when `OLLAMA_URL` is on this machine. Default `~/.ollama/models` |
| `NODE_ENV`      | no     | Node                 | Set to `production` by the Docker image                                                                                                                           |
| `TZ`            | no     | Node, Compose        | Time zone of the process. It sets the default of `schedule.timeZone` and, in Docker, comes from Compose (default `UTC`)                                           |

## Docker and Compose only

| Variable                   | Secret | Default                               | Meaning                                                                   |
| -------------------------- | ------ | ------------------------------------- | ------------------------------------------------------------------------- |
| `DIGEST_UID`, `DIGEST_GID` | no     | `1000`                                | User and group the container runs as. Set to `id -u` and `id -g` on Linux |
| `TZ`                       | no     | `UTC`                                 | Time zone in the container                                                |
| `COMPOSE_PROFILES`         | no     | unset                                 | For example `linux` to start the bundled Ollama and `model-pull`          |
| `REFRESH_MODELS`           | no     | unset                                 | `1` makes `model-pull` pull models that are already present               |
| `OLLAMA_MAX_LOADED_MODELS` | no     | `1` in the Compose `ollama` service   | One model in memory at a time. Set it yourself for a host Ollama          |
| `OLLAMA_HOST`              | no     | `http://ollama:11434` in `model-pull` | Read by the `ollama` command in `docker/pull-models.sh`                   |
| `DIGEST_CONFIG`            | no     | `/app/digest.config.json`             | Config file `docker/pull-models.sh` reads the writers from                |

Compose passes `OLLAMA_URL` (default `http://ollama:11434`), `TZ`, `DIGEST_HOST_OS`,
`DIGEST_HOST_ARCH` and `OTEL_EXPORTER_OTLP_ENDPOINT` into the `digest` container. `make docker-*`
exports `DIGEST_HOST_OS` and `DIGEST_HOST_ARCH` from `uname`, and `make tracing-up` sets
`OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318/v1/traces`.

## Tests

| Variable        | Meaning                                                                               |
| --------------- | ------------------------------------------------------------------------------------- |
| `LIVE_OLLAMA`   | `1` runs the live tests in `test/live/` against a real Ollama. They run one at a time |
| `UPDATE_GOLDEN` | `1` rewrites the golden email files in `src/delivery/adapters/email/__fixtures__/`    |

## Which are secrets

`SMTP_PASSWORD`, `SLACK_WEBHOOK_URL` and `GITHUB_TOKEN`. The program removes their values from
logs, run records, traces, delivered messages and error text. For the Slack webhook, the URL path
is what counts as secret. Passwords inside `OLLAMA_URL` or the tracing endpoint are not redacted,
so keep credentials out of those URLs.

## Related

- [Environment configuration](../configuration/environment.md)
- [Files and paths](files-and-paths.md)
- [Rotate secrets](../runbooks/maintain/rotate-secrets.md)
- [Deployment](../architecture/deployment.md)
