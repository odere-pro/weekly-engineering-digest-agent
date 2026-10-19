# Features

Part of the [documentation wiki](../README.md).

The code is split into **feature folders**. A feature folder holds one job: its code, its types, its
tests (next to the code), its fixtures and a `CLAUDE.md` with the maintainer's notes. Each page here
gives the operator's and newcomer's view of one feature: what it is for, what it does, what you can
configure and what can go wrong. The maintainer's view stays in the feature's own `CLAUDE.md`, which
every page links.

Five features own a **port**, an interface the pipeline calls without knowing the real system behind
it: `models`, `guards`, `sources`, `delivery` and `store`. An **adapter** plugs a real system
(Ollama, a feed, SMTP, the file system) into a port and lives in that feature's `adapters/` folder.
See
[feature folders](../architecture/feature-folders.md) and
[ports and adapters](../architecture/ports-and-adapters.md).

## The pipeline, in run order

The `digest` feature chains these steps. The order is collect, guardInput, classify, process, write,
guardOutput, select, deliver. The checks run inside the write step, and render turns the winner into
text for every channel. How data moves between them is in [data flow](../architecture/data-flow.md).

| Feature              | What it does                                                     | Folder                               | Page                    |
| -------------------- | ---------------------------------------------------------------- | ------------------------------------ | ----------------------- |
| Digest (the run)     | Chains all steps, decides how the week ends, saves the record    | [src/digest/](../../src/digest/)     | [digest](digest.md)     |
| Sources (collect)    | Fetches the allowlisted feeds and turns entries into items       | [src/sources/](../../src/sources/)   | [sources](sources.md)   |
| Guards (guardInput)  | Drops collected items that look like attacks                     | [src/guards/](../../src/guards/)     | [guards](guards.md)     |
| Classify             | Scores each item: relevance, area, hype, minor release           | [src/classify/](../../src/classify/) | [classify](classify.md) |
| Process              | Drops sent, duplicate and weak items, picks the top N            | [src/process/](../../src/process/)   | [process](process.md)   |
| Write                | A panel of writers drafts the digest; one retry                  | [src/write/](../../src/write/)       | [write](write.md)       |
| Checks               | Link check and format check on every draft, always on            | [src/checks/](../../src/checks/)     | [checks](checks.md)     |
| Guards (guardOutput) | Rejects drafts with false claims or off-task text                | [src/guards/](../../src/guards/)     | [guards](guards.md)     |
| Select               | A judge picks the best passing draft                             | [src/select/](../../src/select/)     | [select](select.md)     |
| Render               | Builds the Markdown, the plain scoring text and the review sheet | [src/render/](../../src/render/)     | [render](render.md)     |
| Delivery (deliver)   | Sends the digest to a file, email and Slack                      | [src/delivery/](../../src/delivery/) | [delivery](delivery.md) |

## Supporting features

| Feature       | What it does                                                      | Folder                                         | Page                              |
| ------------- | ----------------------------------------------------------------- | ---------------------------------------------- | --------------------------------- |
| Models        | Every model call goes through one port; the Ollama adapter        | [src/models/](../../src/models/)               | [models](models.md)               |
| Store         | Run history, run files and the single-run lock                    | [src/store/](../../src/store/)                 | [store](store.md)                 |
| Config        | Reads and checks `digest.config.json` and `.env`; profiles        | [src/config/](../../src/config/)               | [config](config.md)               |
| Domain        | The shared types: items, drafts, run record, exit codes           | [src/domain/](../../src/domain/)               | [domain](domain.md)               |
| App           | Picks the real adapters and wraps them with redaction and retry   | [src/app/](../../src/app/)                     | [app](app.md)                     |
| CLI           | The `digest` command and its ten sub-commands                     | [src/cli/](../../src/cli/)                     | [cli](cli.md)                     |
| Scheduler     | Weekly cron for `digest serve`, catch-up, retries, OS schedules   | [src/scheduler/](../../src/scheduler/)         | [scheduler](scheduler.md)         |
| Observability | JSON logs and optional traces, with secrets removed               | [src/observability/](../../src/observability/) | [observability](observability.md) |
| Shared        | Small helpers: errors, clocks, retry, weeks, URLs, untrusted text | [src/shared/](../../src/shared/)               | [shared](shared.md)               |
| Evals         | Frozen test data and the harness behind `digest eval`             | [evals/](../../evals/)                         | [evals](evals.md)                 |

Each page has the same headings: what it is for, where it sits, what it does, what you can
configure, what can go wrong, code and tests, and related pages.
