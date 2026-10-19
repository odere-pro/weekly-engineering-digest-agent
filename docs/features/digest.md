# Digest run

Part of [Features](README.md).

## What it is for

This feature runs one weekly digest from start to end. It chains the steps and decides how the
week ends: sent, dry-run, skipped, quiet, blocked or failed. It saves the run record and the run
files, sends failure notes, and finishes a week that was only partly delivered, with no model call.

## Where it sits

It is the conductor: it calls every pipeline step in order, from collect to deliver, as described
in [data flow](../architecture/data-flow.md).

## What it does

- Works out the week id (the ISO week of the run date) and the collection window. `--since` sets
  the window in days; the default is `windowDays`. A window under 1 day is refused.
- Skips the week when it already has a sent digest, unless you pass `--force`. A skipped run
  exits 0 and saves no new record.
- Takes the run lock. Only one run can use a data folder at a time; a second run fails with
  "Another run is in progress".
- If an earlier run reached only some channels, sends the saved `digest.md` to the missing
  channels and stops. This needs no model. It does not happen with `--force` or `--dry-run`.
  It refuses, with a message that mentions `--force`, when `digest.md` is gone or its links differ.
- Checks that Ollama is reachable and every model in use is pulled, before it collects anything.
  A guard role whose checks are all off does not need its model.
- Runs collect, guardInput, classify, process, write, guardOutput, select and deliver in order.
  A dry run stops before deliver. Models run strictly one after another.
- A step can end the week early. `quiet`: nothing was collected, or fewer than 3 items are left
  after process. `blocked`: every draft was rejected by the checks or the output guards.
- At the end it saves `run.json`, the held files, `review.md` and `error.json` (failure only),
  sends a failure note when one is due, and prunes run folders older than `keepWeeks`.
- It never replaces a record that got further. A `sent` week stays `sent`, and a partly
  delivered week stays that way unless the new run reaches a channel too.

| Status    | Exit code | Meaning                                                          |
| --------- | --------- | ---------------------------------------------------------------- |
| `sent`    | 0         | The winner reached every channel                                 |
| `dry-run` | 0         | A winner was written to disk, nothing was sent                   |
| `skipped` | 0         | The week already has a sent digest                               |
| `failed`  | 1         | A health check, a step or a delivery failed, or no writer worked |
| `blocked` | 2         | Drafts exist and every one was rejected                          |
| `quiet`   | 3         | Nothing collected, or fewer than 3 items worth sending           |

## What you can configure

- `windowDays`, `topN`, `dedupeWeeks`, `keepWeeks` and `dataDir`. See
  [collection limits](../configuration/collection-limits.md) and the
  [config file](../configuration/config-file.md).
- `profile` and `models.writers` decide which models take part. See
  [profiles](../configuration/profiles.md).
- Per run, the flags `--since`, `--dry-run`, `--force`, `--seed` and `--out` of `digest run`.
  See [CLI commands](../reference/cli-commands.md).
- All keys: [config keys](../reference/config-keys.md). The status rules are not configurable.

## What can go wrong

- `failed`: a step error, Ollama down or a model missing, a held lock, or a delivery error. The
  failure note and `error.json` name the step. See
  [failed run](../runbooks/debug/failed-run.md).
- `blocked`: see [blocked run](../runbooks/debug/blocked-run.md).
- `quiet`: often normal. See [quiet week](../runbooks/debug/quiet-week.md).
- "Another run is in progress": see [stuck lock](../runbooks/debug/stuck-lock.md).
- Only some channels got the digest: see
  [resume a partial delivery](../runbooks/recover/resume-partial-delivery.md).
- You need a week sent again: see [re-run a week](../runbooks/recover/re-run-a-week.md) and
  [force a week](../runbooks/run/force-a-week.md).
- "Could not save the run record" means the data folder is not writable or the disk is full. The
  run still sends a note.

## Code and tests

- Folder: [src/digest/](../../src/digest/). Maintainer notes: [CLAUDE.md](../../src/digest/CLAUDE.md).
- No port and no adapters. Only `workflow.ts` imports Mastra, which chains the plain step functions.
- Tests sit next to the code. They use the fakes in [test/fakes](../../test/fakes/); cross-feature
  runs are in [test/integration](../../test/integration/).

## Related

- Steps it calls: [sources](sources.md), [guards](guards.md), [classify](classify.md),
  [process](process.md), [write](write.md), [select](select.md), [delivery](delivery.md).
- [store](store.md) keeps the record and the lock. [scheduler](scheduler.md) calls it every week.
- [Run semantics](../architecture/run-semantics.md) explains skip, resume, force and abort.
