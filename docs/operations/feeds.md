# Feeds

Part of [Operations](README.md).

A failing feed never stops the week. It is skipped and listed in `failedSources` in `run.json`.

## How a feed behaves

- Each fetch has a 10 second timeout per attempt and 2 retries (after 0.5 and 1 second). A
  timeout, network error, 5xx, 408 or 429 is retried. Any other answer fails the source at once.
  These values are fixed, not configurable.
- A redirect is followed only to the same host as the source URL (`www.` counts as the same). Any
  other target fails the source, and the error names the host. A redirect from https to http is
  refused, and so is a chain of more than five.
- A response body over 5 MiB fails the source.
- A GitHub source with `GITHUB_TOKEN` uses the REST API (higher rate limits). A rate-limited
  source is not retried. The token is never sent to another origin.
- A source that returns no usable item is logged as a warning (`Source returned no usable items`),
  not recorded in `run.json`.

The full fetch rules, the default list and the hosts contacted are on [default sources](../sources.md).

## Seeing what a feed returned

```bash
pnpm digest fetch --source <id> --since 7d
```

No models run. Raw and parsed data land in `dist/fetch/<timestamp>/`. See
[fetch sources only](../runbooks/run/fetch-sources-only.md).

## Fixing a failing feed

`pnpm digest doctor` prints one `source` line per feed with a `fix:` line. Fix the URL or remove
the source. See [failing feed](../runbooks/debug/failing-feed.md) and
[update a source](../runbooks/configure/update-a-source.md).

## Limits to know

- GitHub keeps 10 releases per Atom feed. A busy repository can push the oldest release of the
  week out of view.
- Some sources overlap (blog and releases of the same product). URL dedupe does not merge them;
  the process step drops the second item only when both name the same product and version.

## Related

- [Sources feature](../features/sources.md), [source configuration](../configuration/sources.md)
