# Deployment

Part of [Architecture](README.md).

Three ways to run the same code. All of them need Ollama; the digest never calls a hosted model.

## Docker Compose

The image is non-root and runs `digest serve` by default. The Compose project is `eng-digest`
(`docker-compose.yml`). Compose bind-mounts `./data` to `/app/data` and `./data/digests` to
`/app/dist/digests`, so Docker keeps its files under `data/`.

| Service      | Profile   | Role                                                                 |
| ------------ | --------- | -------------------------------------------------------------------- |
| `digest`     | always    | The scheduler (`serve`) and one-shot commands (`docker compose run`) |
| `ollama`     | `linux`   | Ollama in a container, models in the `ollama-models` volume          |
| `model-pull` | `linux`   | Pulls the profile's models once, then exits                          |
| `jaeger`     | `tracing` | Trace viewer on `127.0.0.1:16686`                                    |

- **Mac.** Docker cannot use the Apple GPU, so Ollama runs on the host and the container calls
  `http://host.docker.internal:11434`. `make docker-*` exports `DIGEST_HOST_OS` and
  `DIGEST_HOST_ARCH`, so the container picks the Mac profiles.
- **Linux.** Compose adds its own Ollama (`--profile linux`). Every profile uses the fallback
  model set. `DIGEST_UID` and `DIGEST_GID` let the container write `./data` and read a
  `chmod 600` `.env`.
- **Stopping.** `stop_grace_period` is 90 minutes, so `docker compose stop` waits for a running
  digest. See [stopping and restarts](../operations/stopping-and-restarts.md).

The config and `.env` are bind-mounted from the project folder and must exist before the first
start. Secrets are read from the mounted `.env`, not from `env_file`, so they stay out of
`docker inspect`.

## Node

`pnpm digest <command>` runs from source with tsx. `pnpm build` makes `dist/cli.js`
(`node dist/cli.js <command>`). A host scheduler calls `digest run`, or you keep
`digest serve` running. `digest init` prints a launchd, systemd or `schtasks` entry for the host
scheduler. Those fire in the machine's local time zone, not `schedule.timeZone`.

## One machine, one replica

The lock is a file on local disk. Do not run two copies against one `data/` folder, and do not
share `data/` over a network file system. The cloud is a proposal only:
[cloud proposal](../operations/cloud-proposal.md).

## Which to choose

| You have                    | Use                            | Runbook                                                            |
| --------------------------- | ------------------------------ | ------------------------------------------------------------------ |
| A Mac that is on most days  | Compose with host Ollama       | [Install with Compose](../runbooks/set-up/install-with-compose.md) |
| A Linux box                 | Compose with `--profile linux` | [Install with Compose](../runbooks/set-up/install-with-compose.md) |
| A dev machine and no Docker | Node and a host timer          | [Install with Node](../runbooks/set-up/install-with-node.md)       |

## Related

- [Schedule weekly runs](../runbooks/set-up/schedule-weekly-runs.md)
- [Scheduler feature](../features/scheduler.md), [environment variables](../reference/environment-variables.md)
