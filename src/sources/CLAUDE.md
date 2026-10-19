# Sources

> Fetches the allowlisted RSS/Atom feeds and GitHub releases and turns each entry into one `Item`.
> Entry: `collectStep(input, deps) → { items, failedSources }` (`collect.ts`). Port:
> `SourceFetcher`. All item text is untrusted; these URLs are the only links a digest may contain.

## Context

```mermaid
flowchart LR
  cfg[("config: sources, windowDays, maxItemsPerSource")] -.-> collect:::focus
  collect -.->|"fetch, per source"| sf[[SourceFetcher]]
  sf -.-> adapters["adapters: rss, github"]
  adapters -.-> feeds[("feed hosts, api.github.com")]
  collect -->|"Item[]"| guardInput
  classDef focus stroke-width:3px
```

## Flow

```mermaid
flowchart TD
  kind{"fetcher for source.kind? (4 sources at once)"}
  kind -->|no| failed
  kind -->|yes| fetch["fetcher.fetch: 10 s per attempt, 2 retries (0.5 s, 1 s)"]
  fetch -->|"gave up"| failed["failedSources: error cut to 300 chars"]
  fetch --> adapter["adapter request and parse, then normalizeEntry: http(s) link, valid date, 600-char summary"]
  adapter --> trim["window, newest first, cap, fill empty summaries from the page"]
  trim --> merge["acceptItems (ItemSchema, window), then mergeOutcomes: drop duplicate ids, cap per source"]
  merge --> out["Item[] newest first"]
```

- Retry: `FetchError.retryable` is final. Timeouts, 5xx, 408, 429 retry; other 4xx, a GitHub rate
  limit, a bad URL, a refused redirect and an unparseable feed do not. Else only `TimeoutError` and
  bare transport failures retry.
- The 10 s covers page enrichment too, so pages get 4 s in all (3 s each, 4 at once, 2 MiB each).
  Only entries with no text are enriched, never GitHub (`enrichable: false`). The page must be on
  the feed's host, protocol and port. A page problem is debug-logged and never fails the source.
- Entries of one feed that share a link (Google Cloud release notes) get `?entry=<id>`. The whole
  feed decides, not the window, so an entry keeps its URL from week to week.

## Rules

- A broken feed never stops the week. A source that returns nothing usable logs a warning: a quiet
  week and a silently broken feed look alike.
- `normalizeEntry` is the only place an `Item` is built: http(s) links only (the link check trusts
  what is collected), and a date with no zone is read as UTC (`parseFeedDate`).
- Every fetch goes through `getText`: at most 5 redirects, by hand, only to the source's own host
  (`www.` is the same) or the adapter's `redirectHosts` (`api.github.com`); no https to http,
  other port, credentials in a URL or non-http(s) target. A body over 5 MiB fails the source.
- The GitHub token goes only to the start origin (`accept` and `x-github-api-version` may travel);
  the REST adapter redacts it from network errors. A rate limit is not retried (asking again can
  lengthen the penalty). Release links stay on github.com. Errors name the source id and a refused
  host, never the URL: config values may carry secrets.
- Sources merge in config order, so the earlier source wins a duplicate id. Duplicates go before
  the per-source cap (`source.maxItems ?? maxItemsPerSource`), so they cannot crowd out real items.

## Files

| File                                    | Role                                                                                                              |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `SourceFetcher.ts`, `defaultSources.ts` | The port; `DEFAULT_SOURCES` (24 feeds) and `DEFAULT_FOCUS_AREAS`                                                  |
| `collect.ts`                            | `collectStep`: concurrency, timeout, retry, validation, merge, cap, order                                         |
| `adapters/pipeline.ts`                  | `createFetcher`, `normalizeEntry`, `SourceAdapter`, `RawEntry`, `SourceTap`                                       |
| `adapters/http.ts`, `enrich.ts`         | `getText`, `sameSiteAs`; `enrichEntries` (page text for empty summaries)                                          |
| `adapters/feedFields.ts`                | Raw feed fields and `parseFeedDate`; its `RawEntry` is not the pipeline's                                         |
| `adapters/rss.ts`, `rssAdapter.ts`      | `createRssFetcher`; the RSS 2.0 and Atom adapter                                                                  |
| `adapters/github*.ts`                   | `githubReleases` picks REST with a token (20 per page, no drafts or prereleases), else `releases.atom` (about 10) |

Tests sit next to the code; `adapters/__fixtures__/` holds feed, GitHub and article samples.

## Gotchas

- `defaultSources.test.ts` fails when `DEFAULT_SOURCES` drifts from `digest.config.example.json` or
  from the table and the "Only these hosts" paragraph in `docs/sources.md`.
- Renames break `cli/fetch` (`createFetcher`, the three adapters, `SourceTap`) and
  `evals/recordSources.ts` (`MAX_PAGE_BYTES`, `withoutElements`, `hostsOf`); evals call `collectStep`.
- Page redirects follow `hostsOf(DEFAULT_SOURCES)`: the fetcher options expose no `collectionHosts`,
  so the hosts of configured sources are not used.
- `pipeline.ts` is 338 lines, over the 300 cap. Split it before adding to it.
