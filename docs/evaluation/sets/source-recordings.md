# Source recordings

Part of [Eval sets](README.md).

The real response each default source served, saved byte for byte, with a hand-checked list of the
items it must yield. The eval runs the real RSS and GitHub fetchers over them, offline.

## What it contains

`evals/sources/<source id>/` for each of the 24 default sources (14 RSS feeds and 10 GitHub
repositories), recorded on 2026-10-17. Together they hold 980 expected items and 293 saved pages.

| File                       | What                                                                                          |
| -------------------------- | --------------------------------------------------------------------------------------------- |
| `response.json`            | The URL requested, `status`, `contentType`, `fetchedAt` and `bodyFile` (or an `error`)        |
| `body.xml`                 | The response body, byte for byte (`body.json` for a JSON feed). Untrusted: read, never run it |
| `expected.json`            | `reviewed`, `entryCount`, `items` and `knownGaps`. Written by hand, never touched by tools    |
| `pages/<item id>.html.txt` | The article page of an entry whose feed has no text, for the page-enrichment step             |

`items` are what the body must yield for a window that covers every entry, up to 100. Four feeds
hold more entries than that (`openai-news`, `nodejs-blog`, `huggingface-blog`, `azure-updates`),
so their `items` are the newest 100. `knownGaps: ["summary"]` would excuse a fetcher that returns
an empty summary for a body that has text. No source uses it today. Per-source numbers are in
[evals/sources/README.md](../../../evals/sources/README.md).

## Why it exists

Every digest starts with feeds. If a fetcher drops entries or returns empty summaries, the
classifier and the writers work from nothing. This set tests the input side with no network, so
it does not change from day to day, and it needs no model.

## Metrics it feeds

- [Source parse yield](../metrics/source-parse.md): items parsed over items expected.
- [Source summary fill](../metrics/source-summary-fill.md): parsed items with a summary of at
  least 40 characters.

## How the eval uses it

`evaluateSources` gives each fetcher a `fetch` that answers the recorded URL with the recorded
body and status, a recorded page URL with its page, and anything else with 404. It counts, per
source: items parsed and expected, invalid items, empty titles, short summaries, bad dates, ids
that are not the hash of the URL and links outside the allowed hosts. Only the first two
counts feed metrics. The rest are collected but no gate uses them. For example, all 100
`azure-updates` items link to a host outside the allowlist.

`evals/dataset.sources.test.ts` is stricter: it compares every field of every item with
`expected.json`, and fails when a default source has no recording.

## How to refresh it

```bash
pnpm tsx evals/recordSources.ts
```

One GET per source (20 s timeout, 5 MiB cap, no token). A source that fails keeps its old
recording. After a refresh run `git diff --stat evals/sources`: a feed that moved shows as a
changed body. Then **regenerate `expected.json` from the new body and check it by hand again**;
the conformance test fails until they agree.

```bash
pnpm tsx evals/recordSources.ts --pages
```

Saves the article page for each entry the feed gives no text for: RSS sources only, 4 at a time,
a 2 MiB cap, and only on the feed's own host. A page already on disk is kept; delete it to
refresh. Scripts, styles, SVG and site navigation are dropped first. Redirects to another host
and errors are reported and not saved.

## Rules the data must follow

- Every default source has a recording, and `reviewed` is `true` once its `expected.json` has
  been checked against the body: entry count, titles, links, dates and summary text.
- A new default source needs a recording and a hand-checked `expected.json`. Its host must be in
  the [default source list](../../sources.md), which a test compares with `SOURCE_ALLOWED_HOSTS` in
  `evals/sourceConformance/conformance/sourceAllowedHosts.ts`.
- Page files are named `<item id>.html.txt` and must match an expected item.
- Recorded bodies are untrusted text.

More: [adding cases](../adding-cases.md), [sources](../../features/sources.md).
