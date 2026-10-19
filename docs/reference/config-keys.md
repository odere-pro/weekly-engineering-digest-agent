# Config keys

Part of [Reference](README.md).

Every key of `digest.config.json`, from `src/config/schema.ts`. Only `focusAreas` and `sources`
are required. A key with a default may be left out. Unknown keys are ignored without a warning.
`sources[*]` means each entry of the `sources` list; `<role>` is one of `classify`,
`guardPolicy`, `guardRisk`, `write`, `judge`.

| Key                                        | Type                       | Default                               | Range and rules                                  | Page                                                              |
| ------------------------------------------ | -------------------------- | ------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------- |
| `profile`                                  | enum                       | `quality`                             | `quality`, `fast`, `light`                       | [profiles](../configuration/profiles.md)                          |
| `focusAreas`                               | string array               | required                              | 1 to 25 entries, unique ignoring case, not empty | [focus areas](../configuration/focus-areas.md)                    |
| `sources`                                  | object array               | required                              | at least 1, ids unique                           | [sources](../configuration/sources.md)                            |
| `sources[*].id`                            | string                     | required                              | `^[a-z0-9][a-z0-9-]*$`                           | [sources](../configuration/sources.md)                            |
| `sources[*].kind`                          | enum                       | required                              | `rss`, `github`                                  | [sources](../configuration/sources.md)                            |
| `sources[*].url`                           | URL                        | required                              | no user name or password                         | [sources](../configuration/sources.md)                            |
| `sources[*].area`                          | string                     | none                                  | not empty; a classifier hint                     | [sources](../configuration/sources.md)                            |
| `sources[*].maxItems`                      | integer                    | `maxItemsPerSource`                   | 1 to 100                                         | [sources](../configuration/sources.md)                            |
| `windowDays`                               | integer                    | 7                                     | 1 to 31                                          | [collection limits](../configuration/collection-limits.md)        |
| `maxItemsPerSource`                        | integer                    | 20                                    | 1 to 100                                         | [collection limits](../configuration/collection-limits.md)        |
| `topN`                                     | integer                    | 5                                     | 3 to 5                                           | [collection limits](../configuration/collection-limits.md)        |
| `dedupeWeeks`                              | integer                    | 4                                     | 0 to 12                                          | [collection limits](../configuration/collection-limits.md)        |
| `keepWeeks`                                | integer                    | 12                                    | 1 or more, and at least `dedupeWeeks`            | [collection limits](../configuration/collection-limits.md)        |
| `dataDir`                                  | string                     | `data`                                | not empty                                        | [collection limits](../configuration/collection-limits.md)        |
| `schedule.cron`                            | string                     | `45 7 * * 1`                          | not empty; `serve` checks the syntax             | [schedule](../configuration/schedule.md)                          |
| `schedule.timeZone`                        | string                     | zone of the process                   | not empty; `serve` checks the name               | [schedule](../configuration/schedule.md)                          |
| `delivery.markdown.dir`                    | string                     | `dist/digests`                        | not empty                                        | [Markdown delivery](../configuration/delivery-markdown.md)        |
| `delivery.email`                           | object                     | absent (email off)                    | the object turns email on                        | [email delivery](../configuration/delivery-email.md)              |
| `delivery.email.host`                      | string                     | required with `delivery.email`        | not empty                                        | [email delivery](../configuration/delivery-email.md)              |
| `delivery.email.port`                      | integer                    | 587                                   | 1 to 65535                                       | [email delivery](../configuration/delivery-email.md)              |
| `delivery.email.secure`                    | boolean                    | `false`                               | `true` is TLS from the first byte                | [email delivery](../configuration/delivery-email.md)              |
| `delivery.email.requireTLS`                | boolean                    | `true`                                | require STARTTLS before login                    | [email delivery](../configuration/delivery-email.md)              |
| `delivery.email.user`                      | string                     | required with `delivery.email`        | not empty                                        | [email delivery](../configuration/delivery-email.md)              |
| `delivery.email.from`                      | string                     | required with `delivery.email`        | an email address                                 | [email delivery](../configuration/delivery-email.md)              |
| `delivery.email.to`                        | string array               | required with `delivery.email`        | at least 1, each an email address                | [email delivery](../configuration/delivery-email.md)              |
| `delivery.slack`                           | object                     | absent (Slack off)                    |                                                  | [Slack delivery](../configuration/delivery-slack.md)              |
| `delivery.slack.enabled`                   | boolean                    | `false`                               | needs `SLACK_WEBHOOK_URL` in `.env`              | [Slack delivery](../configuration/delivery-slack.md)              |
| `guards.input.enabled`                     | boolean                    | `true`                                | `false` turns off all three input checks         | [guards](../configuration/guards.md)                              |
| `guards.input.mode`                        | enum                       | `any`                                 | `any`, `all`                                     | [guards](../configuration/guards.md)                              |
| `guards.input.checks.ruleInjection`        | boolean                    | `true`                                | fixed rules, no model call, runs first           | [guards](../configuration/guards.md#the-rule-guard-ruleinjection) |
| `guards.input.checks.clefPolicy`           | boolean                    | `true`                                |                                                  | [guards](../configuration/guards.md)                              |
| `guards.input.checks.graniteRisk`          | boolean                    | `true`                                |                                                  | [guards](../configuration/guards.md)                              |
| `guards.output.enabled`                    | boolean                    | `true`                                | `false` turns off both output checks             | [guards](../configuration/guards.md)                              |
| `guards.output.mode`                       | enum                       | `any`                                 | `any`, `all`                                     | [guards](../configuration/guards.md)                              |
| `guards.output.checks.graniteGroundedness` | boolean                    | `true`                                |                                                  | [guards](../configuration/guards.md)                              |
| `guards.output.checks.clefRubric`          | boolean                    | `true`                                |                                                  | [guards](../configuration/guards.md)                              |
| `thresholds.minRelevance`                  | number                     | 1.5                                   | 0 to 3                                           | [thresholds](../configuration/thresholds.md)                      |
| `thresholds.maxHype`                       | number                     | 0.6                                   | 0 to 1                                           | [thresholds](../configuration/thresholds.md)                      |
| `thresholds.maxMinorRelease`               | number                     | 0.75                                  | 0 to 1                                           | [thresholds](../configuration/thresholds.md)                      |
| `thresholds.guardFlag`                     | number                     | 0.35                                  | 0 to 1                                           | [thresholds](../configuration/thresholds.md)                      |
| `models.writers`                           | string array               | the profile's panel                   | at least 1, unique                               | [models](../configuration/models.md)                              |
| `models.timeoutsMs`                        | map of `<role>` to integer | per role (60000 to 600000)            | each value 1000 or more                          | [models](../configuration/models.md)                              |
| `models.retries`                           | integer                    | 2                                     | 0 to 5                                           | [models](../configuration/models.md)                              |
| `models.think`                             | map of `<role>` to setting | `guardRisk` off, others model default | `true`, `false`, `low`, `medium`, `high`         | [models](../configuration/models.md)                              |
| `models.seed`                              | integer                    | 42                                    | 0 or more                                        | [models](../configuration/models.md)                              |
| `models.temperature`                       | map of `<role>` to number  | `write` 0.2, others 0                 | each value 0 to 2                                | [models](../configuration/models.md)                              |
| `models.rescoreWithWriter`                 | boolean                    | `false`                               | accepted; no effect in `digest run` today        | [models](../configuration/models.md)                              |

## Rules across keys

- `keepWeeks` must be at least `dedupeWeeks`.
- Focus areas are unique ignoring case. Source ids are unique. Writers are unique.
- Defaults for `models.timeoutsMs` per role: `classify` 60000, `guardPolicy` 60000,
  `guardRisk` 120000, `judge` 120000, `write` 600000.
- There is no key for the link check or the format check. They always run.
- Secrets are not config keys: see [environment variables](environment-variables.md).

## Related

- [Configuration overview](../configuration/README.md) and [the config file](../configuration/config-file.md)
- [`digest.config.example.json`](../../digest.config.example.json)
- [src/config/CLAUDE.md](../../src/config/CLAUDE.md)
