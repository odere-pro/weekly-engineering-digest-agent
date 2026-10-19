# Fetch source run

> Fetches the sources: the fetchers of a run wired to a recorder, one source at a time with a time
> limit, up to four at once. Entry: `fetchSource(source, run) → SourceReport` (`fetchSource.ts`),
> `mapWithConcurrency(inputs, limit, fn)`. Port: `SourceFetcher`.

## Flow

```mermaid
flowchart TD
  run["FetchRun: fetchers, recorder, window, limits"] --> pool["mapWithConcurrency: 4 at once, input order kept"]
  pool --> one["fetchSource: run.fetchers[source.kind].fetch, withTimeout"]
  one -.->|"fetch(source, window, signal)"| port[[SourceFetcher]]
  port -.->|"every answer, entry counts"| rec["recorder.tap"]
  one -->|"Outcome"| rep["reportOf: last answer, entries, duration"]
  rec -.-> rep
  rep --> err["errorText: redact, one line, no control characters, 300 chars"] --> out[SourceReport]
```

## Rules

- One try, no retry: this command shows what a source does the first time. The limit is the
  deps' `sourceTimeoutMs`, for the feed and any article pages together.
- A failure becomes a report with `ok: false` and no items, never a throw: the other sources and the
  saved raw body still count. Secrets leave an error text first, then it is cut.
- The recorder keeps answers per source id, so sources fetched at once never share answers.
- `buildFetchers` picks REST with a GitHub token, else the Atom feed, as the container does.

## Files

| File                    | Role                                                                    |
| ----------------------- | ----------------------------------------------------------------------- |
| `fetchSource.ts`        | `fetchSource`, `errorText`; private `reportOf` and the `Outcome` type   |
| `buildFetchers.ts`      | `buildFetchers`: the RSS and GitHub fetchers wired to the recorder      |
| `recorder.ts`           | `createRecorder`: answers and entry counts by source id, kept in memory |
| `mapWithConcurrency.ts` | `mapWithConcurrency`: a bounded pool that keeps the input order         |
| `types.ts`              | `SourceReport`, `FetchRun`                                              |

## Gotchas

- `buildFetchers.test.ts` uses the scripted network of `../__fixtures__/fetchHarness.ts`;
  `fetchSource.test.ts` uses `FakeSourceFetcher`.
- `recorder.ts`, `buildFetchers.ts` and `types.ts` are the only files here that may use the words
  `tap`, `SourceTap`, `SourceAnswer`, `SourceEntries` (`../fetch.tap.test.ts`), comments included.
- `Recorder.tap` has both listeners set (`Required<SourceTap>`), so tests call them directly.
