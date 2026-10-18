# Sources

## Intent

This feature gets the raw material for the week. It fetches the allowlisted RSS/Atom feeds and
GitHub releases and turns every entry into one `Item` shape: id, source, url, title, plain-text
summary and date. All of that text is untrusted. The URLs collected here are the only links a
digest may contain. A broken feed must never stop the week.

## How it works

1. `collectStep(input, deps)` (`collect.ts`) takes the sources, the window and
   `maxItemsPerSource`. It works on up to 4 sources at once (`mapWithConcurrency`).
2. `collectSource` picks the `SourceFetcher` (port, `SourceFetcher.ts`) by `source.kind`
   (`rss` or `github`). No fetcher for the kind fails that source.
3. `fetchWithRetry` calls `fetcher.fetch(source, window, signal)` with `withTimeout` (10 s per
   attempt) and `withRetry` (2 retries, 500 ms then 1 s). `isRetryableFetchError` decides.
4. The real fetchers come from `createFetcher(adapter, options)` (`adapters/pipeline.ts`). The
   adapter's `request` does the GETs through `getText` (`adapters/http.ts`). Its `parse` returns
   raw entries. `normalizeEntry` builds each `Item`: http(s) link and valid date only, summary
   through `toPlainText` and `truncate` (600 chars), id from `itemIdFor(url)`.
5. The pipeline gives entries that share a link a `?entry=<id>` parameter, keeps only the
   window, sorts newest first, caps at `window.maxItems`, and fills empty summaries with
   `enrichEntries` (`adapters/enrich.ts`), which reads the entry's own page.
6. Adapters: `rssAdapter` (RSS 2.0 and Atom, `@extractus/feed-extractor`), `githubAtomAdapter`
   (`releases.atom`, no token), `createGithubRestAdapter(token)` (REST, 20 per page, no drafts
   or prereleases). `createRssFetcher` and `createGithubReleasesFetcher` are what
   `app/container.ts` wires. A GitHub token picks the REST adapter.
7. Back in `collect.ts`, `acceptItems` re-checks each item with `ItemSchema` and the window.
   `mergeOutcomes` removes duplicate ids (the earlier source in config order wins) and caps each
   source at `source.maxItems ?? maxItemsPerSource`. The result is `{ items, failedSources }`.

## Design

- Feed problems never make `collectStep` throw. A failed source goes to `failedSources`. Its error
  text is capped at 300 chars because fetcher errors are untrusted.
- Retry rule: `FetchError.retryable` is final. Timeouts, 5xx, 408 and 429 retry. Other 4xx, a
  GitHub rate limit, a bad URL, a refused redirect and an unparseable feed do not. Otherwise only
  `TimeoutError` and bare network failures retry. Anything else fails fast.
- Network allowlist (security invariant 4). `getText` follows redirects by hand, at most 5, and
  only to the source's own host (`www.` counts as the same) or the adapter's `redirectHosts`
  (`api.github.com`). It refuses https to http, another port, credentials in a URL and non-http(s)
  targets. A body over 5 MiB (`MAX_BODY_BYTES`) fails the source. Caller headers, such as the
  GitHub token, go only to the start origin (`accept` and `x-github-api-version` may travel).
- The GitHub token must not leak. The REST adapter rebuilds network errors from their message
  with the token redacted. A rate limit is not retried. Release links must stay on github.com.
- Page enrichment runs only for entries with no text, and not for GitHub (`enrichable: false`).
  The page must be on the feed's host, protocol and port. A redirect may go to a collected host.
  Limits: 2 MiB per page, 3 s per page, 4 s in total, 4 at once. A page problem is only
  debug-logged and never fails the source.
- `parseFeedDate` reads a date with no zone as UTC, so the digest does not depend on the machine.
- The pipeline logs one line per feed, not one per entry, for entries it could not read.
- `DEFAULT_SOURCES` (24 feeds) must match `digest.config.example.json` and the table in
  `docs/sources.md`. `defaultSources.test.ts` fails when they drift.

## Files

| File                                                                       | Role                                                                              |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `SourceFetcher.ts`                                                         | The port: `SourceFetcher`, `FetchWindow`                                          |
| `collect.ts`                                                               | `collectStep`: timeout, retry, validation, merge, cap, order                      |
| `defaultSources.ts`                                                        | `DEFAULT_SOURCES` and `DEFAULT_FOCUS_AREAS`                                       |
| `adapters/pipeline.ts`                                                     | `createFetcher`, `normalizeEntry`, `SourceAdapter`, `RawEntry`, debug `SourceTap` |
| `adapters/http.ts`                                                         | `getText`, `sameSiteAs`, `statusFailure`, `permanentFailure`, size cap            |
| `adapters/enrich.ts`                                                       | `enrichEntries`, `articleText`: page text for entries with no summary             |
| `adapters/feedFields.ts`                                                   | Raw feed field choices: alternate link, dates, markup, `parseFeedDate`            |
| `adapters/rss.ts`, `rssAdapter.ts`                                         | `createRssFetcher`; the RSS and Atom adapter                                      |
| `adapters/githubReleases.ts`                                               | `createGithubReleasesFetcher`: picks the Atom or REST adapter                     |
| `adapters/githubAtomAdapter.ts`, `githubRestAdapter.ts`, `githubShared.ts` | The two GitHub transports and what they share                                     |
| `*.test.ts`, `adapters/__fixtures__/`                                      | Tests next to the code; feed XML, GitHub JSON and Atom, article HTML              |

## Depends on, used by

Depends on: `domain` (schemas), `shared` (`retry`, `errors`, `text`, `url`, `telemetry`, `clock`).
Used by: `digest/runDigest.ts` (`collectStep`), `app/container.ts` (the two fetchers),
`cli` (`doctor`, `fetch`, `init`), `evals/` (record and replay), `test/fakes/FakeSourceFetcher`.

## Change it safely

- Tests: `collect.test.ts` (retries, caps, order), `adapters/pipeline.test.ts`, `http.test.ts`,
  `rss.test.ts`, `githubReleases.test.ts`, `enrich.test.ts`, `feedFields.test.ts`. No network:
  pass a fake `fetch` that serves `__fixtures__`.
- Two types are called `RawEntry`: the parser's entry in `feedFields.ts` and the adapter's
  entry in `pipeline.ts`. Do not mix them up.
- Every new fetch path must go through `getText`, so redirects, size and credentials stay checked.
- Never put a secret, a feed body or a full URL with credentials into an error or a log line.
- `collect.ts` must not import `adapters/`. The container builds the adapters.
