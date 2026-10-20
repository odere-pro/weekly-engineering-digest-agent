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
  the window in days; the default is `windowDays`, reaching back to where the last delivered
  week's run collected when that is earlier (up to 31 days). A window under 1 day is refused.
- Skips the week when it already has a sent digest, unless you pass `--force`. A skipped run
  exits 0 and saves no new record.
- Takes the run lock. Only one run can use a data folder at a time; a second run fails with
  "Another run is in progress".
- If an earlier run reached only some channels, sends the saved `digest.md` to the missing
  channels and stops. This needs no model. It does not happen with `--force` or `--dry-run`.
  It refuses, with a message that mentions `--force`, when `digest.md` is gone or its links differ.
- Checks that Ollama is reachable and every model in use is pulled, before it collects anything.
  A guard role whose checks are all off does not need its model.
- Runs collect, guardInput, classify, process, guardCandidates, write, guardOutput, select and
  deliver in order. A dry run stops before deliver. Models run strictly one after another.
- A step can end the week early. `quiet`: the sources answered but nothing was collected (or some
  failed and the rest had nothing), or fewer than 3 items are left after process or
  guardCandidates. When every configured source failed, `collect` fails the run instead: that is a
  broken network, not a quiet
  week, so the week is `failed` and the scheduler retries it. If every draft is rejected by the checks or the output guards, the run builds a
  fallback digest from the selected items' own text (no model) and sends that. Only when the
  fallback itself cannot be built does the week end `blocked`. See [Fallback digest](#fallback-digest).
- While it delivers, it saves `run.json` after each channel that takes the digest. A run killed
  in the middle (out of memory, power loss) leaves a partly delivered week, which the next run
  resumes on the missing channels only.
- At the end it saves `run.json`, the held files, `review.md` and `error.json` (failure only),
  sends a failure note when one is due, and prunes the weeks older than `keepWeeks`. A run that
  did not fail removes the `error.json` of an earlier attempt; a `sent` one also removes the
  earlier `<week>.failed.md`.
- It never replaces a record that got further. A `sent` week stays `sent`, and a partly
  delivered week stays that way unless the new run reaches a channel too.

| Status    | Exit code | Meaning                                                                               |
| --------- | --------- | ------------------------------------------------------------------------------------- |
| `sent`    | 0         | The winner reached every channel                                                      |
| `dry-run` | 0         | A winner was written to disk, nothing was sent                                        |
| `skipped` | 0         | The week already has a sent digest                                                    |
| `failed`  | 1         | A health check, a step or a delivery failed, no writer worked, or every source failed |
| `blocked` | 2         | Every draft was rejected and no fallback digest could be made                         |
| `quiet`   | 3         | Sources answered but nothing was collected, or fewer than 3 items worth sending       |

## Fallback digest

When no writer draft passes the link check, the format check and the output guards, the run does
not give up. It builds a digest from the selected items' own title, URL and first sentences of
their summary, with no model call. This is the fallback digest. It is not written by a model: every
item is "good to know", there are no action lines, and the headline only names the areas.

- It passes the same link check and format check as any draft. The output guards look at it once
  and only advise: a flag is logged and kept in `run.json`, it never blocks the digest.
- The run then ends `sent` (or `dry-run`) and exits 0. No failure note is sent, so look for these
  signs: `"fallback": true` in `run.json`, a `drafts` entry with writer `fallback`, the footer line
  "Written from the sources' own words." in the digest, and a log warning
  `No draft survived; sending the fallback`.
- There is no config key or CLI flag to switch it off. `RunOptions.noFallback` exists for tests and
  the eval replay only. A week where every writer produced no draft at all (a model fault) still
  ends `failed`: the fallback covers rejected drafts, not missing ones.
- `blocked` is still possible if the fallback fails its own checks. The log then says
  `The fallback digest failed its own checks; the week stays blocked`, which is a bug to report.

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

- `failed`: a step error (also when every source failed), Ollama down or a model missing, a held
  lock, or a delivery error. The
  failure note and `error.json` name the step. See
  [failed run](../runbooks/debug/failed-run.md).
- `sent` with `fallback: true`: the writers' drafts were all rejected. See
  [blocked run](../runbooks/debug/blocked-run.md), which now covers this case too.
- `blocked`: rare now; see [blocked run](../runbooks/debug/blocked-run.md).
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
- No port and no adapters. `workflow.ts` is a plain loop that runs the step functions in order.
  The Mastra framework was removed: [ADR 0001](../architecture/decisions/0001-mastra.md) (accepted).
- Tests sit next to the code. They use the fakes in [test/fakes](../../test/fakes/); cross-feature
  runs are in [test/integration](../../test/integration/).

## Related

- Steps it calls: [sources](sources.md), [guards](guards.md), [classify](classify.md),
  [process](process.md), [write](write.md), [select](select.md), [delivery](delivery.md).
- [store](store.md) keeps the record and the lock. [scheduler](scheduler.md) calls it every week.
- [Run semantics](../architecture/run-semantics.md) explains skip, resume, force and abort.
