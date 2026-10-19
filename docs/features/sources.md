# Sources

Part of [Features](README.md).

## What it is for

This feature gets the raw material for the week. It fetches your allowlisted RSS/Atom feeds and
GitHub releases and turns every entry into one item shape: id, source, URL, title, plain-text
summary and date. All of that text is untrusted. The URLs collected here are the only links a
digest may contain. A broken feed never stops the week.

## Where it sits

It is the first step, collect, at the start of the chain described in
[data flow](../architecture/data-flow.md).

## What it does

- Fetches up to 4 sources at once. Each attempt has a 10 second limit and a failed fetch is retried
  twice (after 0.5 s, then 1 s). Timeouts, HTTP 5xx, 408, 429 and network errors retry. Other 4xx,
  a GitHub rate limit, a bad URL, a refused redirect and an unparsable feed do not.
- Reads two kinds of source. `rss` covers RSS 2.0 and Atom. `github` reads a repository's releases:
  the public Atom feed without a token, or the REST API (20 per page, no drafts or prereleases)
  when `GITHUB_TOKEN` is set.
- Keeps entries with an http(s) link and a valid date that fall inside the window, newest first.
  A date with no zone is read as UTC. Each source is capped at its own `maxItems`, else at
  `maxItemsPerSource`. Duplicate ids are removed; the source earlier in config order wins.
- Cuts each summary to plain text of at most 600 characters. When an entry has no summary, it reads
  the entry's own page (never for GitHub). Limits: same host, 2 MiB per page, 3 s per page, 4 s in
  total. A page problem never fails the source.
- Follows redirects by hand, at most 5, and only to the source's own host (`www.` counts as the
  same) or `api.github.com`. It refuses https to http, other ports, credentials in a URL and
  non-http(s) targets. A response over 5 MiB fails the source. The token goes only to the first
  host.
- A source that fails goes to `failedSources` in `run.json`, with its error text cut to 300
  characters. The other sources carry on. If nothing at all is collected, the week ends `quiet`.
- `digest init` writes the 24 default sources. See the [default source list](../sources.md).

## What you can configure

- `sources[]` with `id`, `kind`, `url`, `area` (a hint for the classifier) and `maxItems`. See
  [sources](../configuration/sources.md).
- `windowDays` and `maxItemsPerSource`. See
  [collection limits](../configuration/collection-limits.md).
- `GITHUB_TOKEN` in `.env`. See [environment](../configuration/environment.md).
- The fetch time limit, retries and the 5 MiB cap are fixed in code. All keys:
  [config keys](../reference/config-keys.md).
- There is no per-source "disabled" switch. To stop using a feed, remove it from `sources`. See
  [remove or disable a source](../runbooks/configure/remove-or-disable-a-source.md),
  [add a source](../runbooks/configure/add-a-source.md) and
  [update a source](../runbooks/configure/update-a-source.md).

## What can go wrong

- A feed times out, moves, returns an error or cannot be parsed. It shows in `failedSources`, in
  the logs and as a `source` line in `digest doctor`. See
  [failing feed](../runbooks/debug/failing-feed.md).
- GitHub rate-limits you. A rate-limited source is not retried; set `GITHUB_TOKEN`.
- A feed that parses but has no entries in the window is not an error and is not listed anywhere
  in `run.json`.
- Every source fails or the window is empty: the week is `quiet`. See
  [quiet week](../runbooks/debug/quiet-week.md).
- To see what a feed returned, with no models, run `pnpm digest fetch --source <id>`. See
  [fetch sources only](../runbooks/run/fetch-sources-only.md) and
  [feeds](../operations/feeds.md).

## Code and tests

- Folder: [src/sources/](../../src/sources/). Maintainer notes: [CLAUDE.md](../../src/sources/CLAUDE.md).
- Port: [SourceFetcher.ts](../../src/sources/SourceFetcher.ts). Adapters:
  [src/sources/adapters/](../../src/sources/adapters/) (RSS and Atom, GitHub, the fetch pipeline).
- Tests sit next to the code and never use the network: they serve recorded feeds and pages from
  a fixtures folder beside the adapters.

## Related

- Next step: [guards](guards.md) check each collected item.
- [digest](digest.md) turns a failed or empty collect into `quiet` or a note.
- [evals](evals.md) replays recorded feed responses to measure parsing.
- Safety rules for fetching: [safety](../architecture/safety.md).
