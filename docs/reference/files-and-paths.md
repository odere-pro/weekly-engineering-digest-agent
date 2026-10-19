# Files and paths

Part of [Reference](README.md).

Where every file lives, for a Node install and for Docker. Relative paths are relative to the
folder you run `digest` from (the project folder).

## Node

Everything the project produces goes below the data folder, `dist/` by default (`dataDir`).

| What                         | Path                                                                                   | Moved by                             |
| ---------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------ |
| Config                       | `digest.config.json`                                                                   | `-c, --config <path>`                |
| Secrets and machine settings | `.env`                                                                                 | nothing: always `./.env`             |
| Data folder                  | `dist/`                                                                                | `dataDir`                            |
| Build output                 | `dist/artifacts/cli.js` and `cli.js.map`                                               | `pnpm build`                         |
| Run lock                     | `dist/digest.lock`                                                                     | `dataDir`                            |
| Logs                         | `dist/logs/<day>/digest.log`, and standard output (JSON lines)                         | `dataDir`, `LOG_LEVEL`               |
| Run folder of a week         | `dist/<monday>/digest/`                                                                | `dataDir`                            |
| Digest files                 | `dist/<monday>/digest/<week>.md`, `<week>.html`, `<week>.failed.md`                    | `delivery.markdown.dir`, `run --out` |
| Source data of a run         | `dist/<monday>/<source>/raw/` and `formatted/items.json`                               | `dataDir`                            |
| Fetch output                 | `dist/<day>/<source>/raw/`, `formatted/items.json` and `dist/<day>/fetch-summary.json` | `fetch --out`                        |
| Preview output               | `dist/<monday>/digest/preview/`                                                        | `preview --out` (`<dir>/<week>/`)    |
| Feedback labels              | `dist/feedback/<week>.json`                                                            | `dataDir`                            |
| Eval checkpoints             | `dist/eval/checkpoints/<date>/`                                                        | `dataDir`                            |
| Eval scorecards              | `evals/scorecards/<date>-<profile>.json`                                               | nothing                              |

`<monday>` is the Monday of the run's ISO week: `2026-W43` is `2026-10-19`, whatever day the run
actually ran, so a resume or `--force` finds the same folder (`dist/2026-10-19/digest/`). `<day>` is
a date in `schedule.timeZone`: the day of a log file, or the day `digest fetch` ran. The `dist/`,
`.env` and `digest.config.json` paths are git-ignored.

## The data folder

```text
dist/                                     dataDir (default "dist")
  artifacts/cli.js, cli.js.map            `pnpm build` output
  digest.lock                             the run lock
  logs/<day>/digest.log                   every log line as JSON, one file per day
  <monday>/digest/                        a week's run: run.json, items.json, scores.json,
                                          drafts.json, digest.md, review.md, error.json
                                          + the Markdown channel's <week>.md, <week>.html, <week>.failed.md
                                          + preview/ (the `digest preview` default)
  <monday>/<sourceId>/raw/                response-<n>.<xml|json|html> and responses.json
  <monday>/<sourceId>/formatted/items.json
  <day>/<sourceId>/raw|formatted          `digest fetch` output for the day it runs
  <day>/fetch-summary.json                `digest fetch` summary
  feedback/<week>.json                    `digest feedback` output
  eval/checkpoints/                       `digest eval --resume` checkpoints
```

`<monday>/digest/` holds `run.json`, `items.json`, `scores.json`, `drafts.json`, `digest.md`,
`review.md` and, after a failure, `error.json`. Fields and contents: [run record](run-record.md).

`raw/` holds every answer a source gave, one `response-<n>.<xml|json|html>` per answer, and
`responses.json` with the file, url (origin and path only; the query may hold a secret), status and
content type of each. `formatted/items.json` holds
the items the fetch returned. Secrets are taken out of what is saved. In `fetch-summary.json`, the
`raw` list of a source has paths such as `example-feed/raw/response-1.xml`, and `formatted` the
path of its items.

Weeks older than `keepWeeks` keep only `digest.md` and the delivered `<week>.md`, `<week>.html` and
`<week>.failed.md` in `digest/`; their source folders are deleted. The `digest fetch` folders and
the logs (`logs/<day>/`) of every day before the oldest kept week are deleted as well. A source
cannot have the id `digest`.

## Other files the commands write

| Command                     | Writes                                                                                                                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `init`                      | `digest.config.json` and `.env` (mode 600), at the paths above                                                                                                                                   |
| `run`, `serve`              | The run folder, the source data, the digest files (and a failure note `<week>.failed.md`), the log file, the lock while it runs                                                                  |
| `fetch`                     | `<out>/<day>/<id>/raw/` and `formatted/items.json`, and `<out>/<day>/fetch-summary.json`. `<out>` is the data folder unless `--out` says otherwise. A second fetch on the same day replaces them |
| `preview`                   | `digest.md`, `email.html`, `email.txt`, `slack.json` in the week's `digest/preview/`; with `--out`, in `<out>/<week>/`                                                                           |
| `feedback`                  | `dist/feedback/<week>.json`                                                                                                                                                                      |
| `eval`                      | `evals/scorecards/<date>-<profile>.json` (a second run on the same day overwrites it), the checkpoints and the log file                                                                          |
| `show`, `history`, `doctor` | Nothing                                                                                                                                                                                          |

`fetch` writes only its sources' folders and the summary, never the `digest/` folder or the lock.
A fetch on a Monday uses the same `<monday>/<source>/` folders as the run of that week, and
replaces what is there.

## Docker

Compose mounts only these paths from the project folder into the `digest` container:

| Container path            | Host path            | Holds                                                                  |
| ------------------------- | -------------------- | ---------------------------------------------------------------------- |
| `/app/digest.config.json` | `digest.config.json` | The config. It must exist before the first run                         |
| `/app/.env`               | `.env`               | Secrets and settings. It must exist before the first run               |
| `/app/dist`               | `dist/`              | The data folder: runs, source data, digest files, logs, lock, feedback |

The image runs the CLI from `/opt/eng-digest/dist/artifacts/cli.js`, outside the mounted folder, so
the mount cannot hide it. With the default `dataDir` (`dist`) and no `delivery.markdown.dir`, the
digest files reach `dist/<monday>/digest/` on the host. A `delivery.markdown.dir` under `dist/`,
such as `dist/digests`, works too. Any other folder lives inside the container and is lost when it
is removed.

The same is true of `evals/scorecards` and of an `--out` outside `dist/` in a one-off
`docker compose run --rm` container. To keep that output, point `--out` at a folder inside `dist/`.

Other Docker files:

| What                             | Where                                                                       |
| -------------------------------- | --------------------------------------------------------------------------- |
| Logs                             | `dist/logs/<day>/digest.log`, and `docker compose logs digest` (JSON lines) |
| Ollama models (Linux profile)    | the `ollama-models` volume, at `/root/.ollama` in the `ollama` service      |
| Trace viewer (`tracing` profile) | Jaeger at `http://localhost:16686`                                          |
| Compose project                  | `docker-compose.yml`, project name `eng-digest`                             |

On Linux, create `dist/` yourself (`mkdir -p dist`) and set `DIGEST_UID` and `DIGEST_GID`, or
Docker creates it as root.

## Related

- [Data layout](../architecture/data-layout.md) and [deployment](../architecture/deployment.md)
- [Config keys](config-keys.md) and [environment variables](environment-variables.md)
- [Disk and pruning](../operations/disk-and-pruning.md)
- [Change the output folder](../runbooks/configure/change-the-output-folder.md)
