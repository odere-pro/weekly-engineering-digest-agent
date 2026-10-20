# Upgrade the tool

Part of [Runbooks](../README.md) / Maintain.

## Purpose

Move an installed copy to a newer version of the tool itself, on Node or in Docker. You end with
the new code running, checked by `doctor` and a dry run, and with the scheduler restarted on it.

## When to use

- New commits or a new tag are on the remote and you want them.
- To change the models only, use [Upgrade models](upgrade-models.md). To replace a secret, use
  [Rotate secrets](rotate-secrets.md).
- To publish a new version as the maintainer, use [Cut a release](../release/cut-a-release.md).

## Prerequisites

- You installed from a clone ([Install with Node](../set-up/install-with-node.md) or
  [Install with Docker Compose](../set-up/install-with-compose.md)). The package is not on npm or
  GHCR, so a `git pull` is the only way to get new code.
- `git status --short` prints nothing for tracked files. `digest.config.json`, `.env` and `dist/`
  are not tracked, so a pull never changes them.
- No digest is running. The lock file `dist/digest.lock` exists only while a run is going
  ([Stuck lock](../debug/stuck-lock.md)). Pick a time away from your schedule (default Monday
  07:45). In Docker, step 7 waits for a running digest, for up to 90 minutes.
- Node: Node 24 or newer and the pnpm version in `package.json`. Docker: Compose 2.24 or newer.
  Both builds download packages, so you need a network.

## Steps

1. Note the version you run now. You need it to roll back.

   ```bash
   git describe --tags --always
   ```

2. Fetch, then read what changed. Look under **Changed** and **Removed** for a renamed config key,
   a new model tag or a moved folder. These may need a manual edit of `digest.config.json` or
   `.env`, or a model to pull.

   ```bash
   git fetch --tags origin
   git log --oneline HEAD..origin/main
   git diff HEAD origin/main -- CHANGELOG.md
   ```

3. Update the checkout. `--ff-only` stops, instead of merging, if you have local commits. To pin a
   release instead of the newest `main`, run `git checkout vX.Y.Z`.

   ```bash
   git pull --ff-only
   ```

4. Install the new code.
   - Node: install the locked dependencies, then build. The build is needed for the built CLI
     (`node dist/artifacts/cli.js`), which an OS timer from
     [Schedule weekly runs](../set-up/schedule-weekly-runs.md) calls. Without it the timer keeps
     running the old code.

     ```bash
     pnpm install --frozen-lockfile
     pnpm build
     ```

   - Docker: build the image. `docker compose up -d` alone does not build; it keeps the old local
     image `eng-digest:local`.

     ```bash
     docker compose build
     ```

5. Check the install. Fix every `✗` before you go on. If a model is missing, `doctor` prints the
   `ollama pull` line under `fix:`.
   - Node:

     ```bash
     pnpm digest doctor
     ```

   - Docker (this uses the new image; the old container is still running). On a Mac, export
     `DIGEST_HOST_OS=darwin DIGEST_HOST_ARCH=arm64` first. On Linux, add `--profile linux`.

     ```bash
     docker compose run --rm digest doctor
     ```

6. Try the new code without sending anything. If this week is already `sent`, the dry run ends
   `skipped`: add `--force` (it never replaces the sent record).
   - Node:

     ```bash
     pnpm digest run --dry-run --out ./try
     ```

   - Docker (leave out `--out`: a folder inside the container is lost):

     ```bash
     docker compose run --rm digest run --dry-run
     ```

7. Switch the scheduler to the new code.
   - Docker on a Mac: `make docker-up` (it exports the two host variables). Docker on Linux:
     `docker compose --profile linux up -d`. Compose sees a new image and recreates `digest`. It
     stops the old container first and waits for a digest that is running. If you also run Jaeger,
     start with the command you used before, for example `make tracing-up`.

     ```bash
     make docker-up
     ```

   - Node with `digest serve`: stop it with one Ctrl-C (a running digest finishes first), then
     start it again. `serve` reads the code and the config once, at start.

     ```bash
     pnpm digest serve
     ```

   - Node with an OS timer: nothing to restart. Step 4 rebuilt the CLI it calls.

8. Optional: if the changelog names changes to prompts, guards, thresholds or the classifier, run
   the evals and record a new baseline: [Run evals](../run/run-evals.md),
   [Re-baseline evals](re-baseline-evals.md).

## Verify

- `git describe --tags --always` prints a different value than in step 1.
- `doctor` ends with no `✗` and exits 0. The dry run exits 0 and prints `Dry run: nothing was sent.`
- Docker: `docker compose ps` shows `digest` up, and `docker compose logs digest` has a line
  `Scheduler started` with the `nextRun` you expect. The image is new:
  `docker image inspect eng-digest:local --format '{{.Created}}'` shows today.
- After the next real run, `pnpm digest history -n 1` shows the week as `sent`.

## Roll back

Go back to the value you noted in step 1, then repeat steps 4 and 7.

```bash
git checkout <the value from step 1>
```

Git leaves you on a detached HEAD. To upgrade again later, run `git checkout main` first.

`dist/`, `digest.config.json` and `.env` do not roll back with the code. If you edited the config
for the new version, put the old keys back. A run record that only the new version can read is
ignored by the old one (log line `Ignoring unreadable run.json`), so the old version may treat that
week as not run. Run `pnpm digest history` and check the latest weeks before you start `serve`.

## Troubleshooting

| Symptom                                                            | Cause                                                       | Fix                                                                                                        |
| ------------------------------------------------------------------ | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `error: Your local changes to the following files would be ...`    | You edited a tracked file                                   | Copy your edit away, `git restore <file>`, then pull again.                                                |
| `fatal: Not possible to fast-forward, aborting.`                   | You have local commits that `origin/main` does not have     | Rebase them (`git rebase origin/main`), or move them to a branch and pull again.                           |
| `ERR_PNPM_OUTDATED_LOCKFILE` from `pnpm install --frozen-lockfile` | `package.json` was edited, so it no longer matches the lock | `git restore package.json pnpm-lock.yaml`, then install again.                                             |
| The install or build fails right away                              | Node is older than 24                                       | `node --version`. Install Node 24 or newer.                                                                |
| `docker compose up -d` starts the old code                         | The image was not built after the pull                      | `docker compose build`, then step 7 again.                                                                 |
| `docker compose up -d` takes a very long time                      | The old container is finishing a running digest             | Wait (the limit is 90 minutes), or see [Stopping and restarts](../../operations/stopping-and-restarts.md). |
| `doctor`: `Invalid config in ...`                                  | The new version changed or removed a config key             | Read the message and the changelog (step 2). Edit the key, then run `doctor` again.                        |
| `doctor`: `model <tag>: not installed`                             | The new version needs another model                         | Run the `ollama pull` line under `fix:`. On Linux, `up -d` pulls missing models for you.                   |
| `doctor`: `... falls back to the untuned profile`                  | Mac: the two host variables are not set                     | Use `make`, or export `DIGEST_HOST_OS` and `DIGEST_HOST_ARCH`.                                             |
| `Another run is in progress` in the dry run                        | The scheduler or another run holds the lock                 | [Stuck lock](../debug/stuck-lock.md). Try the dry run again when the run is over.                          |

## Related

- [Upgrade models](upgrade-models.md), [Rotate secrets](rotate-secrets.md)
- [Install with Node](../set-up/install-with-node.md), [Install with Docker Compose](../set-up/install-with-compose.md)
- [Stopping and restarts](../../operations/stopping-and-restarts.md), [Deployment](../../architecture/deployment.md)
- [CHANGELOG](../../../CHANGELOG.md)
