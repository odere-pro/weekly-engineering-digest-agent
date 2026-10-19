# Configuration

Part of the [documentation home](../README.md).

Everything you can tune lives in two places. `digest.config.json` holds the settings: what to
watch, how many items to keep, which guards and models run, where the digest goes. `.env` holds
the secrets and a few machine settings. This folder has one page per area.

Only `focusAreas` and `sources` are required. Every other key has a default, so a small file works.

## Areas

| Area               | Keys                                                                                                                                     | Page                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| The file           | the whole file, validation, when changes apply                                                                                           | [config-file.md](config-file.md)             |
| Profile            | `profile`                                                                                                                                | [profiles.md](profiles.md)                   |
| Focus areas        | `focusAreas`                                                                                                                             | [focus-areas.md](focus-areas.md)             |
| Sources            | `sources`                                                                                                                                | [sources.md](sources.md)                     |
| Collection limits  | `windowDays`, `maxItemsPerSource`, `topN`, `dedupeWeeks`, `keepWeeks`, `dataDir`                                                         | [collection-limits.md](collection-limits.md) |
| Guards             | `guards.input`, `guards.output`                                                                                                          | [guards.md](guards.md)                       |
| Thresholds         | `thresholds`                                                                                                                             | [thresholds.md](thresholds.md)               |
| Models             | `models.writers`, `models.timeoutsMs`, `models.retries`, `models.think`, `models.seed`, `models.temperature`, `models.rescoreWithWriter` | [models.md](models.md)                       |
| Judge              | no key of its own; follows `profile` and `models.writers`                                                                                | [judge.md](judge.md)                         |
| Schedule           | `schedule.cron`, `schedule.timeZone`                                                                                                     | [schedule.md](schedule.md)                   |
| Markdown delivery  | `delivery.markdown.dir`                                                                                                                  | [delivery-markdown.md](delivery-markdown.md) |
| Email delivery     | `delivery.email`                                                                                                                         | [delivery-email.md](delivery-email.md)       |
| Slack delivery     | `delivery.slack`                                                                                                                         | [delivery-slack.md](delivery-slack.md)       |
| Environment (.env) | secrets, `OLLAMA_URL`, `LOG_LEVEL`, tracing, host detection                                                                              | [environment.md](environment.md)             |

## A minimal valid file

```json
{
  "profile": "light",
  "focusAreas": ["AI models and tooling", "Platform engineering"],
  "sources": [
    {
      "id": "ollama-releases",
      "kind": "github",
      "url": "https://github.com/ollama/ollama",
      "area": "ai-tooling"
    },
    {
      "id": "nodejs-blog",
      "kind": "rss",
      "url": "https://nodejs.org/en/feed/blog.xml",
      "area": "platform"
    }
  ]
}
```

[`digest.config.example.json`](../../digest.config.example.json) shows a full file with the 24
default sources and every guard written out. `pnpm digest init` writes a working file for you.

## Related

- [Config keys reference](../reference/config-keys.md): one table with every key, type, default and limit.
- [Environment variables reference](../reference/environment-variables.md)
- [Runbooks for configuration changes](../runbooks/README.md)
- [src/config/CLAUDE.md](../../src/config/CLAUDE.md): how the loader works, for maintainers.
