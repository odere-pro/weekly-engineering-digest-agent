# Install with Docker Compose

Part of [Runbooks](../README.md) / Set up.

## Purpose

Run the weekly scheduler (`digest serve`) as a container that restarts by itself. Config, secrets
and run history stay in the clone folder, so the container can be thrown away.

## When to use

- You want the digest to run unattended on a Mac or a Linux box.
- Use [Install with Node](install-with-node.md) to run from source, or when Docker is not an option.

## Prerequisites

- Docker with Compose 2.24 or newer: `docker compose version`.
- A clone of the repo: `git clone https://github.com/odere-pro/weekly-engineering-digest-agent.git`.
- Mac: the Ollama app on the host, 0.40.0 or newer. Docker cannot use the Apple GPU, so the
  container talks to the host Ollama at `http://host.docker.internal:11434`.
- Linux: nothing else. Compose adds its own Ollama (profile `linux`) and pulls the models into the
  `ollama-models` volume. For an NVIDIA GPU, uncomment `gpus: all` in `docker-compose.yml`.
- Disk for the models: see [choose a profile and pull models](choose-profile-and-pull-models.md).

In Docker every command is `docker compose run --rm digest <command>`. The global option
`-c, --config <path>` goes before the command name.

## Steps

### Mac

1. Create the config and `.env`. This makes both files (mode 600 for `.env`) and runs `digest init`
   in a container. `init` needs no Ollama. Its delivery question shows the folder where the digest
   is always saved: `./dist/<monday>/digest/` on the host.

   ```bash
   make docker-init
   ```

2. Pull the models on the host with `ollama pull <tag>`. The tags are in
   [choose a profile and pull models](choose-profile-and-pull-models.md).
3. Check the setup. `make` exports `DIGEST_HOST_OS` and `DIGEST_HOST_ARCH` for you. With plain
   `docker compose` you must export them, or the Linux container picks the untuned fallback models.

   ```bash
   export DIGEST_HOST_OS=darwin DIGEST_HOST_ARCH=arm64
   docker compose run --rm digest doctor
   ```

4. Do a [first run](first-run.md) (a dry run) before you start the scheduler.
5. Start the scheduler. This runs `docker compose up -d`.

   ```bash
   make docker-up
   ```

### Linux

1. Make the folders and files, and tell Compose which user owns them. Without `dist`, Docker
   creates it as root and the container cannot write the runs, digest files and logs.

   ```bash
   mkdir -p dist && touch digest.config.json && (umask 077 && touch .env)
   echo "DIGEST_UID=$(id -u)" >> .env && echo "DIGEST_GID=$(id -g)" >> .env
   ```

2. Create the config. `init` merges into the `.env` you just made and keeps both lines.

   ```bash
   docker compose run --rm --no-deps digest init
   ```

3. Start the services. The first start downloads about 45 GB of models, so it takes a while.

   ```bash
   docker compose --profile linux up -d
   ```

4. Check the setup, then do a [first run](first-run.md).

   ```bash
   docker compose --profile linux run --rm digest doctor
   ```

On Linux every profile resolves to the fallback models (`clef:latest`, `granite4.1-guardian:8b`,
`gemma4:31b`). Only `models.writers` in the config changes that set.

## Verify

- `docker compose ps` shows `digest` up. On Linux `ollama` is up and `model-pull` has exited 0.
- `docker compose logs digest` has a line with `Scheduler started`, `cron`, `timeZone` and `nextRun`.
- `doctor` ends with `Doctor: all checks passed.` (or only warnings you accept) and exits 0.
- Digests appear in `dist/<monday>/digest/<week>.md` and `<week>.html` after a run, with the run
  record and the sources' data beside them. Logs go to `dist/logs/<day>/digest.log`.

## Roll back

```bash
docker compose --profile linux down
```

This removes the containers. `dist/`, `digest.config.json` and `.env` stay. Add `--volumes` to also
delete the `ollama-models` volume (Linux). Delete `dist/` only if you want to lose the run history, fetched data and logs.

## Troubleshooting

| Symptom                                               | Cause                                           | Fix                                                                                                |
| ----------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Compose cannot parse `docker-compose.yml`             | Compose older than 2.24                         | Upgrade Docker Compose.                                                                            |
| Compose says a bind source path does not exist        | `digest.config.json` or `.env` was not created  | `touch digest.config.json .env`, then run `init` again.                                            |
| `doctor`: `ollama: ... no answer`                     | Mac: the Ollama app is not running              | Start it. `OLLAMA_URL` in `.env` must be `http://host.docker.internal:11434`.                      |
| `doctor`: `... falls back to the untuned profile`     | Mac: `DIGEST_HOST_OS` and `_ARCH` were not set  | Use `make`, or export both variables (step 3).                                                     |
| `.env is readable by others and cannot be restricted` | Linux: the container user cannot chmod the file | `chmod 600 .env` on the host, and set `DIGEST_UID` and `DIGEST_GID`.                               |
| Digest files are not written (permission denied)      | Docker created `dist` as root                   | Change its owner to your user, or remove it and recreate it before `up`.                           |
| The schedule fires at the wrong hour                  | The container runs on UTC unless `TZ` is set    | Set `schedule.timeZone`: [change the schedule](../configure/change-the-schedule-and-time-zone.md). |

## Related

- [First run](first-run.md), [Schedule weekly runs](schedule-weekly-runs.md)
- [Deployment](../../architecture/deployment.md), [Environment variables](../../reference/environment-variables.md)
- [Stopping and restarts](../../operations/stopping-and-restarts.md)
