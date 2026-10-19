# Shared

## Intent

Small helpers that many features need and no feature should own: errors with exit codes, clocks,
retry and timeout, ISO weeks, URL and text cleaning, the untrusted-data wrapper, and the `Logger`
and `Tracer` interfaces. They hold no state and do no I/O, so any layer can import them. Putting
them here stops features from importing each other for small things.

## How it works

1. A failure is a `DigestError(message, { exitCode, step, cause })`. The default `exitCode` is 1.
   `FetchError` adds `status` and `retryable`. `errorMessage(error)` gives text for any thrown value.
2. Slow or flaky calls use `withRetry(fn, options)` and `withTimeout(fn, ms, parent)`. The options
   are `retries`, `baseDelayMs`, `maxDelayMs`, `shouldRetry`, `onRetry` and `sleep`. The first
   waits `baseDelayMs * 2^attempt` between tries. The second gives `fn` an `AbortSignal` and
   rejects with `TimeoutError` when time is up.
3. Time comes from a `Clock` (`systemClock`, `fixedClock(at)`). Week ids come from
   `isoWeekId(date, timeZone)`, for example `2026-W43`. `weekStartUtc`, `previousWeekIds`,
   `compareWeekIds` and `parseWeekId` work on those ids.
4. Collected feed text is cleaned with `toPlainText(html)`, `truncate(text, maxChars)` and
   `wordCount(text)`. Links are compared with `normalizeUrl(url)` and `sameUrl(a, b)`, and named
   with `itemIdFor(url)`.
5. A prompt embeds collected text only through `wrapUntrusted(label, text)`, with
   `UNTRUSTED_DATA_RULE` in the system prompt.
6. `Logger` and `Tracer` (`telemetry.ts`) are interfaces, with `noopLogger` and `noopTracer`.
   `src/observability` holds the real ones.

## Design

- No state and no I/O. The one Node import is `node:crypto` in `url.ts`. Time and sleeping are
  passed in (`Clock`, `sleep`), so tests do not wait.
- It imports only `domain/schemas` (`ExitCode`, `StepName`, `WEEK_ID_PATTERN`), in `errors.ts` and
  `isoWeek.ts`. `domain` never imports `shared`, so there is no cycle.
- Item ids must stay stable. `itemIdFor` is the first 16 hex characters of the sha256 of
  `normalizeUrl(url)`.
- `normalizeUrl` lowercases the host and drops the default port, the fragment, `utm_*` and the
  params `ref`, `fbclid`, `gclid`, `mc_cid`, `mc_eid` and `source`. It sorts the query and removes
  a trailing slash (not on the root). A non-http(s) input comes back trimmed.
- `isoWeekId` follows ISO 8601: the Thursday of the week sets the year. `weekStartUtc` is Monday
  00:00 UTC.
- `toPlainText` stays linear on hostile input, such as a long run of unclosed `<script>` tags.
  `truncate` cuts at a word, adds `...`, and never splits a surrogate pair.
- `wrapUntrusted` swaps `<<<` and `>>>` in the text for look-alike characters and limits the label
  to `[\w.:-]`, so collected text cannot close its own data block.
- `DigestError.exitCode` becomes the process exit code: Sent 0, Failed 1, Blocked 2, Quiet 3.
- `withRetry` counts `retries` as extra tries after the first; `attempt` starts at 0.

## Files

| File            | Role                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------ |
| `clock.ts`      | `Clock`, `systemClock`, `fixedClock`                                                                               |
| `errors.ts`     | `DigestError`, `FetchError`, `NotImplementedError`, `errorMessage`                                                 |
| `isoWeek.ts`    | `isoWeekId`, `parseWeekId`, `weekStartUtc`, `previousWeekIds`, `compareWeekIds`                                    |
| `retry.ts`      | `withRetry`, `withTimeout`, `TimeoutError`                                                                         |
| `telemetry.ts`  | `Logger`, `Tracer`, `LogFields`, `noopLogger`, `noopTracer`                                                        |
| `text.ts`       | `toPlainText`, `truncate`, `wordCount`                                                                             |
| `untrusted.ts`  | `wrapUntrusted`, `neutralize`, `UNTRUSTED_DATA_RULE`, `DATA_OPEN`, `DATA_CLOSE`                                    |
| `url.ts`        | `normalizeUrl`, `itemIdFor`, `sameUrl`                                                                             |
| `*.test.ts`     | `errors`, `isoWeek`, `retry`, `text`, `untrusted`, `url`. `clock.ts` and `telemetry.ts` have no test of their own. |
| `__fixtures__/` | None. Tests build their inputs inline.                                                                             |

## Depends on, used by

Depends on: `domain/schemas` only, plus `node:crypto`.
Used by: almost every folder. `errors` and `telemetry` are everywhere. `untrusted` is used by
`classify`, `write`, `select`, `guards`, `models` and `digest`. `url` is used by `sources/adapters`,
`checks`, `process`, `write` and `evals`. `retry` is used by `models/adapters`, `sources`,
`app/container`, `cli/doctor` and `cli/fetch`. `isoWeek` is used by `digest`, `scheduler`,
`store/adapters` and `evals`.

## Change it safely

- This folder is frozen on issue branches (`.claude/rules/parallel-work.md`). Set the issue to
  `blocked`, write the change under `## Notes`, and let the coordinator make it on `main`.
- Run `pnpm vitest run src/shared`. Check one file with
  `pnpm vitest run --coverage --coverage.include='src/shared/url.ts'`.
- Do not change `normalizeUrl` or `itemIdFor` without re-recording. Every id in `evals/weeks/`,
  `evals/classifier-cases.json` and `evals/sources/*/expected.json` is a hash of a normalized URL,
  and `evals/dataset.*.test.ts` will fail.
- Do not renumber `ExitCode` values or reuse a code. Schedulers and scripts read them
  (`docs/reference/exit-codes.md` lists them).
- Do not import a feature folder from here. Keep new helpers pure and take time as a `Clock`.
- `NotImplementedError` is left over from the first build wave. `cli/init` still checks for it.
  Remove both together or leave both.
- A change to the `Logger` or `Tracer` interface needs a matching change in `src/observability`
  and in `test/fakes`.
