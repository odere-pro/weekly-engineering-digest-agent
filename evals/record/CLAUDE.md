# Record

> Freezes live feed output into the eval data. `pnpm eval:record` writes the last 6 ISO weeks into
> `evals/weeks/<week>/`. Entry: `recordWeeks(options, deps) → string[]` (`../recordWeeks.ts`).
> The parts live here. `../recordSources.ts` freezes the feeds themselves (see `../sourceConformance/`).

## Context

```mermaid
flowchart LR
  cmd["pnpm eval:record"] -->|"RecordWeeksOptions"| entry["recordWeeks.ts"] --> record["record/: fetchers, weeks, report"]:::focus
  cfg[("digest.config.json, .env")] -.->|"sources, GITHUB_TOKEN"| record
  record -->|"SourceFetcher per kind"| collect["collectStep"]
  collect -.-> feeds[("feeds, GitHub")]
  collect -->|"Item[]"| record
  record -->|"items.json, labels.json, candidates.md"| weeks[("evals/weeks/")]
  weeks -->|"6 recorded weeks"| replay["runEval: replay"]
  classDef focus stroke-width:3px
```

## Flow

```mermaid
flowchart TD
  opts["weeks, outDir"] --> ok{"a whole number, 1 or more?"}
  ok -->|no| bad["DigestError, before any request"]
  ok -->|yes| src["fetchers/: resolveSources, createDefaultFetchers"]
  src --> collect["collectStep: weeks plus 1 back, 100 items per source"]
  collect --> bucket["weeks/bucketByWeek: one bucket per complete ISO week"]
  bucket --> each["weeks/recordWeek per week, all settled"]
  each --> files[("items.json, labels.json, candidates.md")]
  each --> rep["report/reportLines: weeks, sources, failed sources"]
```

- The window is one week longer than the weeks recorded, so the oldest week is not cut by the
  clock. The running week and anything older than the recorded weeks are dropped by `bucketByWeek`.
- The default fetchers get `reportLogger`: a skipped feed entry means a recording that lacks it, so a
  warning becomes a report line.

## Rules

- People own the labels: `labels.json` is created once from `LABELS_TEMPLATE` (`wx` flag) and never
  rewritten. The recorder never writes `expected.json`, the hand-checked file of a source recording.
- `items.json` only grows: feeds drop old entries, so a rewrite would shrink a labeled week. Recorded
  items stay as they are, even if the feed edited them; a failed source is filled in on the next run.
- `candidates.md` is derived from `items.json` and rewritten every run, so they never disagree.
- Written files go through `formatLikeRepo`, so committed recordings pass `pnpm format:check`.
- A broken `items.json` or config fails with a `DigestError` that names the file; nothing falls back
  to defaults or resets the data.
- Report lines have the GitHub token taken out and are one line each, whatever a feed put in them.
- When one week fails to write, the others finish first (`allSettled`): no write outlives the call.

## Files

| File                             | Role                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------- |
| `../recordWeeks.ts`              | `recordWeeks`, `RecordWeeksDeps`, `RECORDED_ITEMS_PER_SOURCE`; the CLI entry |
| `../recordSources.ts`            | Saves each default source's response; `--pages` saves article pages          |
| `../feedbackToLabels.ts`         | Merges `digest feedback` into `labels.json`; never changes an existing label |
| `types.ts`                       | `WeekRecord`, `ResolvedSources`: what the report and the fetchers share      |
| `display.ts`, `fsErrors.ts`      | `oneLine`, `pluralizeItems`; `hasErrorCode` for `ENOENT` and `EEXIST`        |
| `weeks/`, `report/`, `fetchers/` | Week files, report lines, sources and fetchers. See each `CLAUDE.md`         |

Tests sit next to each file. `__fixtures__/recordKit.ts` has two sources and the item builders.

## Gotchas

- `package.json` runs `tsx evals/recordWeeks.ts`: the entry stays at that path, and the check
  against `import.meta.url` (realpath of `argv[1]`) is what starts it. `evals/weeks` is relative to it.
- `replayWindow.test.ts` imports `RECORDED_ITEMS_PER_SOURCE` from the entry. The replay itself caps
  each source as production does.
- `recordWeeks.test.ts` spies on `createRssFetcher` and `createGithubReleasesFetcher`; keep
  `createDefaultFetchers` calling them from those modules.
- Report text is pinned by tests, line for line. Change it with them.
- Feed text in `items.json` is untrusted: read it, never run it.
