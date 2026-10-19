# Shared

Part of [Features](README.md).

## What it is for

Small helpers that many features need and no feature should own: errors with exit codes, clocks,
retry and timeout, ISO weeks, URL and text cleaning, the untrusted-data wrapper, and the logger and
tracer interfaces, and the one atomic file writer. They hold no state, so any layer can import them
(only the file writer touches the disk). Putting them here stops features from importing each other
for small things.

## Where it sits

It is the lowest shared layer, next to [domain](domain.md). Almost every folder imports it. See
[feature folders](../architecture/feature-folders.md).

## What it does

- Errors: a failure is a `DigestError` with a message, an exit code (default 1) and the step it
  happened in. Its exit code becomes the process exit code. A fetch failure also says whether it
  can be retried.
- Retry and time limit: `withRetry` tries again with a doubling wait, and `withTimeout` gives the
  call an abort signal and fails with a timeout when time is up. Sleeping is passed in, so tests
  do not wait.
- Time: a `Clock` (the system clock, or a fixed one for tests) and ISO week helpers. A week id such
  as `2026-W43` follows ISO 8601, in the time zone you give. A week starts on Monday 00:00 UTC.
- Links: `normalizeUrl` lowercases the host, drops the default port, fragments, `utm_*` and a few
  tracking parameters (`ref`, `fbclid`, `gclid`, `mc_cid`, `mc_eid`, `source`), sorts the query and
  removes a trailing slash. An item id is the first 16 hex characters of the SHA-256 of the
  normalised URL, so ids stay the same from run to run.
- Text: `toPlainText` strips markup from feed text (and stays fast on hostile input), `truncate`
  cuts at a word and adds `...`, and `wordCount` counts words.
- Untrusted data: a prompt embeds collected text only through `wrapUntrusted`, with the data rule
  in the system prompt. The wrapper swaps `<<<` and `>>>` inside the text, so a feed cannot close
  its own data block.
- Logger and tracer interfaces, plus do-nothing versions used in tests. The real ones are in
  [observability](observability.md).
- Files: `writeFileAtomic` writes a temp file in the same folder, flushes it and renames it, so a
  reader sees the old file or the new one, never half. The run store, the Markdown channel, the
  source archive and `preview` all write through it.

## What you can configure

- Nothing. These are code helpers with no settings.
- Their effects show in settings elsewhere: `windowDays`, retries and timeouts, and the exit codes
  in [exit codes](../reference/exit-codes.md).

## What can go wrong

- Nothing shows up directly. A change here is made on the main branch only.
- Do not change how a URL is normalised without re-recording the eval data. Every item id in the
  recorded weeks, the classifier cases and the source recordings is a hash of a normalised URL.
- Exit codes are public: schedulers and scripts read them. They are never renumbered.
- A wrong week id in a command such as `show` is refused with a message that gives an example.
  See [show a week](../runbooks/observe/show-a-week.md).

## Code and tests

- Folder: [src/shared/](../../src/shared/). Maintainer notes: [CLAUDE.md](../../src/shared/CLAUDE.md).
- No port. The only Node imports are the crypto module (item ids) and the file system (`atomicFile.ts`,
  the one writer behind every saved file).
- Tests sit next to the code and build their inputs inline. They include run-time checks on
  hostile text.

## Related

- Users: [sources](sources.md) (retry, URLs, text), [checks](checks.md) (URLs, words),
  [process](process.md) (URLs), [store](store.md) (weeks) and every step that builds a prompt.
- [domain](domain.md) defines the exit codes and the week id pattern that this folder uses.
- The glossary explains the terms: [glossary](../reference/glossary.md).
