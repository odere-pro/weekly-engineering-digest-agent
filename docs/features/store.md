# Store

Part of [Features](README.md).

## What it is for

The digest runs once a week and must not run twice at the same time, send the same week twice, or
repeat last week's releases. The `RunStore` port keeps the run history (one record and a few files
per ISO week) and the single-run lock. The file adapter does this on a plain folder, so the whole
tool stays local-first with no database.

## Where it sits

It is a supporting layer used at the start and the end of every run, as shown in
[ports and adapters](../architecture/ports-and-adapters.md). The folder layout is in
[data layout](../architecture/data-layout.md).

## What it does

- Keeps one folder per ISO week at `<dataDir>/runs/<week>/` with `run.json`, `items.json`,
  `scores.json`, `drafts.json`, `digest.md`, `review.md` and, after a failure, `error.json`. Every
  file is written atomically, so a reader never sees half a file.
- Holds the run lock as the file `<dataDir>/digest.lock`. It records the process, the host and a
  heartbeat that the running process refreshes every 60 seconds.
- Treats a lock as abandoned, and takes it over with a warning, when its heartbeat is 5 minutes
  old, when it names this host and a dead process, when this process id comes with another token
  (process 1 after a container restart), or when the file cannot be read. A lock from an older
  version with no heartbeat is abandoned after 6 hours.
- Answers "was this week already sent?" and "which URLs went out recently?". The URL list covers
  the `dedupeWeeks` weeks before the run, and only weeks that reached a channel.
- Prunes at the end of a run: week folders older than `keepWeeks` are emptied except for
  `digest.md`. A failed prune is only logged.
- Serves the commands that read history: `history`, `show`, `preview` and `feedback`.
- A `run.json` that is missing, unreadable, no longer matches the schema or belongs to another
  week is read as "no record", with a warning in the log.
- Week ids become folder names, so only a valid ISO week id such as `2026-W43` is accepted.

## What you can configure

- `dataDir` (default `data`): where runs and the lock live. See the
  [config file](../configuration/config-file.md).
- `keepWeeks` (default 12, at least 1, not below `dedupeWeeks`) and `dedupeWeeks` (0 to 12,
  default 4). See [collection limits](../configuration/collection-limits.md).
- The lock timings are fixed in code. All keys: [config keys](../reference/config-keys.md).
- Keep `dataDir` on a local disk that supports hard links. Network file systems, FAT and exFAT are
  not supported. See [lock](../operations/lock.md) and
  [disk and pruning](../operations/disk-and-pruning.md).

## What can go wrong

- "Another run is in progress": a live run holds the lock. Wait, or see
  [stuck lock](../runbooks/debug/stuck-lock.md). A crashed run's lock is taken over by the next run
  after the heartbeat times out.
- A laptop that sleeps for more than 5 minutes in the middle of a run can lose its lock to another
  run. See [known limits](../operations/known-limits.md).
- The data folder is not writable or the disk is full: the run fails with "Could not save the run
  record". See [failed run](../runbooks/debug/failed-run.md) and
  [prune disk](../runbooks/maintain/prune-disk.md).
- You edited `run.json` by hand and broke it. The week is then read as having no record. Prefer
  `pnpm digest show <week>` to read history. See
  [view run history](../runbooks/observe/view-run-history.md).
- Deleting run folders by hand can make the digest repeat items, because the URLs of those weeks no
  longer count as sent.

## Code and tests

- Folder: [src/store/](../../src/store/). Maintainer notes: [CLAUDE.md](../../src/store/CLAUDE.md).
- Port: [RunStore.ts](../../src/store/RunStore.ts). Adapters:
  [src/store/adapters/](../../src/store/adapters/) (run folders, the lock, atomic file writes).
- Tests sit next to the code and use temporary folders and a fake clock. The lock contention test
  starts real processes, so it runs longer than the rest.

## Related

- [digest](digest.md) takes the lock, saves the files and the record. [scheduler](scheduler.md)
  retries when the lock is held.
- [app](app.md) wraps the store so secrets never reach disk. [domain](domain.md) defines the run
  record. [run record reference](../reference/run-record.md).
