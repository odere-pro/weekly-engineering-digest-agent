# Sources

Part of [Configuration](README.md).

`sources` is the allowlist of feeds the agent reads. It is a list, and it is the only place the
agent gets items from. The agent contacts only the hosts named here (plus `api.github.com` when a
GitHub token is set).

| Key       | Type                    | Default  | Limits                 |
| --------- | ----------------------- | -------- | ---------------------- |
| `sources` | array of source objects | required | at least 1, ids unique |

## Fields of one source

| Field      | Type    | Required | Rule                                                                                |
| ---------- | ------- | -------- | ----------------------------------------------------------------------------------- |
| `id`       | string  | yes      | Lowercase letters, digits and dashes, starting with a letter or digit. Not `digest` |
| `kind`     | string  | yes      | `rss` (RSS or Atom feed) or `github` (releases of one repository)                   |
| `url`      | string  | yes      | A valid URL, without a user name or password                                        |
| `area`     | string  | no       | A hint for the classifier, for example `ai-tooling`. See below                      |
| `maxItems` | integer | no       | 1 to 100. Cap for this source. Falls back to `maxItemsPerSource` (20)               |

```json
{
  "sources": [
    {
      "id": "kubernetes-blog",
      "kind": "rss",
      "url": "https://kubernetes.io/feed.xml",
      "area": "platform"
    },
    {
      "id": "aws-whats-new",
      "kind": "rss",
      "url": "https://aws.amazon.com/about-aws/whats-new/recent/feed/",
      "area": "cloud",
      "maxItems": 40
    },
    {
      "id": "terraform-releases",
      "kind": "github",
      "url": "https://github.com/hashicorp/terraform"
    }
  ]
}
```

## Rules worth knowing

- **GitHub URL.** A `github` source must be exactly `https://github.com/<owner>/<repo>`: https,
  host `github.com`, no port, query or fragment, and a repository name that does not end in
  `.git`. The config loads even when the URL is wrong. The source then fails at fetch time with
  `Source <id> is not a GitHub repository URL`, and `digest doctor` warns.
- **Reserved id.** The id `digest` is refused: a source's data goes in a folder named after it, next
  to the week's `digest/` folder.
- **No credentials in URLs.** A URL with `user:pass@` is refused when the config loads. Keep
  secrets in `.env`. A `GITHUB_TOKEN` there switches GitHub sources from the Atom feed to the REST API.
- **Area hint.** `area` is passed to the classifier as a line `Source tag: <area>`. The classifier
  still picks each item's area from your [focus areas](focus-areas.md). The hint need not match one.
- **Order.** Sources are fetched four at a time. When two sources return the same item, the one
  earlier in the list keeps it.
- **No on/off switch.** A source has no `disabled` key. To stop using one, delete its entry
  (keep a copy elsewhere if you want it back). Unknown keys are ignored, so adding `"enabled": false`
  does nothing.
- **A failing feed does not stop the week.** It is listed in `failedSources` in `run.json`, and
  the run goes on without it. `digest doctor` shows one `source <id>` line per feed.

## Test a source

```bash
pnpm digest fetch --source kubernetes-blog --since 7d
```

This fetches only that source, calls no model and saves the raw reply under
`dist/<day>/kubernetes-blog/raw/` (`<day>` is today). A run keeps the same files for its week.

## Change it

- [Add a source](../runbooks/configure/add-a-source.md)
- [Update a source](../runbooks/configure/update-a-source.md)
- [Remove or disable a source](../runbooks/configure/remove-or-disable-a-source.md)

## Related

- [Default sources, hosts and fetch limits](../sources.md)
- [Collection limits](collection-limits.md): `windowDays` and `maxItemsPerSource`
- [Sources feature](../features/sources.md)
- [Fetch sources only](../runbooks/run/fetch-sources-only.md)
