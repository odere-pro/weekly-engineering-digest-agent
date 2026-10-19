# Files and paths

Part of [Reference](README.md).

Where every file lives, for a Node install and for Docker. Relative paths are relative to the
folder you run `digest` from (the project folder).

## Node

| What                         | Path                                                        | Moved by                             |
| ---------------------------- | ----------------------------------------------------------- | ------------------------------------ |
| Config                       | `digest.config.json`                                        | `-c, --config <path>`                |
| Secrets and machine settings | `.env`                                                      | nothing: always `./.env`             |
| Data folder                  | `data/`                                                     | `dataDir`                            |
| Run folder of a week         | `data/runs/<week>/`                                         | `dataDir`                            |
| Run lock                     | `data/digest.lock`                                          | `dataDir`                            |
| Feedback labels              | `data/feedback/<week>.json`                                 | `dataDir`                            |
| Digest files                 | `dist/digests/<week>.md`, `<week>.html`, `<week>.failed.md` | `delivery.markdown.dir`, `run --out` |
| Fetch output                 | `dist/fetch/<timestamp>/`                                   | `fetch --out`                        |
| Preview output               | `dist/preview/<week>/`                                      | `preview --out`                      |
| Eval scorecards              | `evals/scorecards/<date>-<profile>.json`                    | nothing                              |
| Build output                 | `dist/cli.js`                                               | `pnpm build`                         |
| Logs                         | standard output, JSON lines                                 | `LOG_LEVEL`                          |

There are no log files. The `data/`, `dist/`, `.env` and `digest.config.json` paths are git-ignored.

## Inside a run folder

`data/runs/<week>/` holds `run.json`, `items.json`, `scores.json`, `drafts.json`, `digest.md`,
`review.md` and, after a failure, `error.json`. Fields and contents: [run record](run-record.md).
Folders older than `keepWeeks` keep only `digest.md`.

## Other files the commands write

| Command                     | Writes                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------ |
| `init`                      | `digest.config.json` and `.env` (mode 600), at the paths above                                   |
| `run`                       | The run folder, the digest files, the lock while it runs; a failure note file `<week>.failed.md` |
| `fetch`                     | `<out>/<timestamp>/raw/<id>.<ext>`, `items.json` and `summary.json`. Not in the data folder      |
| `preview`                   | `<out>/<week>/digest.md`, `email.html`, `email.txt`, `slack.json`                                |
| `feedback`                  | `data/feedback/<week>.json`                                                                      |
| `eval`                      | `evals/scorecards/<date>-<profile>.json`. A second run on the same day overwrites it             |
| `show`, `history`, `doctor` | Nothing                                                                                          |

## Docker

Compose mounts only these paths from the project folder into the `digest` container:

| Container path            | Host path            | Holds                                                    |
| ------------------------- | -------------------- | -------------------------------------------------------- |
| `/app/digest.config.json` | `digest.config.json` | The config. It must exist before the first run           |
| `/app/.env`               | `.env`               | Secrets and settings. It must exist before the first run |
| `/app/data`               | `data/`              | Runs, lock, feedback                                     |
| `/app/dist/digests`       | `data/digests/`      | `<week>.md`, `<week>.html`, `<week>.failed.md`           |

The default `delivery.markdown.dir` (`dist/digests`) is `/app/dist/digests`, so the digest files
reach `data/digests/` on the host. Setting it to `data/digests` is the same folder. Any other
folder lives inside the container and is lost when it is removed.

The same is true of `dist/fetch`, `dist/preview` and `evals/scorecards` inside a one-off
`docker compose run --rm` container. To keep that output, point `--out` at a mounted folder: for
`preview`, `--out data/preview`; for `fetch`, which refuses a folder inside the data folder,
`--out dist/digests/fetch` (it lands in `data/digests/fetch` on the host).

Other Docker files:

| What                             | Where                                                                  |
| -------------------------------- | ---------------------------------------------------------------------- |
| Logs                             | `docker compose logs digest` (JSON lines)                              |
| Ollama models (Linux profile)    | the `ollama-models` volume, at `/root/.ollama` in the `ollama` service |
| Trace viewer (`tracing` profile) | Jaeger at `http://localhost:16686`                                     |
| Compose project                  | `docker-compose.yml`, project name `eng-digest`                        |

On Linux, create `data/` and `data/digests/` yourself and set `DIGEST_UID` and `DIGEST_GID`, or
Docker creates them as root.

## Related

- [Data layout](../architecture/data-layout.md) and [deployment](../architecture/deployment.md)
- [Config keys](config-keys.md) and [environment variables](environment-variables.md)
- [Disk and pruning](../operations/disk-and-pruning.md)
- [Change the output folder](../runbooks/configure/change-the-output-folder.md)
