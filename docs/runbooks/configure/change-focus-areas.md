# Change focus areas

Part of [Runbooks](../README.md) / [Configure](README.md).

## Purpose

Change the topics the digest cares about. Focus areas steer which releases the classifier rates as
relevant, and the writers and judge see the same list.

## When to use

- Your team's interests changed, for example you add "Security" or drop "AI models and tooling".
- The digest keeps picking items from a topic you do not follow.
- To change which feeds are read, use [Add a source](add-a-source.md). To change how strict the
  filter is, use [Change thresholds](change-thresholds.md).

## Prerequisites

- `pnpm digest doctor` shows no `✗` line.
- A short list of 1 to 25 topics, each a few words. Plain names work best, such as
  "Platform engineering".
- Write access to `digest.config.json`.

## Steps

1. Open `digest.config.json` and edit `focusAreas`. Rules from the schema:

   - 1 to 25 entries. Each is trimmed and must not be empty.
   - Unique when upper and lower case are ignored ("AI" and "ai" clash).

   ```json
   {
     "focusAreas": ["AI models and tooling", "Platform engineering", "Security"]
   }
   ```

2. Know what changes:

   | Part of the run | Use of `focusAreas`                                                                                                |
   | --------------- | ------------------------------------------------------------------------------------------------------------------ |
   | `classify`      | Relevance is asked "to an engineer who follows these focus areas"; the area question offers your list plus `other` |
   | `process`       | Up to 2 digest slots per area while another area still has items                                                   |
   | `write`         | The writers see the list                                                                                           |
   | `select`        | The judge scores "focus fit" against the list                                                                      |

   The `area` of a source (see [Add a source](add-a-source.md)) is only a hint and need not
   match a focus area. The digest is grouped by urgency (act now, worth a look, good to know),
   not by focus area.

3. Apply the change. `digest serve` reads the config once, at start. In Docker:
   `docker compose restart digest`. A manual `pnpm digest run` and a host timer read the file
   again each time. In Docker, other commands are `docker compose run --rm digest <command>`.
4. Run `pnpm digest doctor` to confirm the file still loads.

## Verify

- After the next run, `pnpm digest show <week> --part scores` has an `Area` column that holds
  only your areas or `other`.
- A dry run is the safe way to try it ([Dry run](../run/dry-run.md)). If the week already has a
  sent digest the dry run is skipped. With `--force` it runs but keeps the old record, so its
  scores cannot be shown. In that case check the next real run.

## Roll back

Put the old list back in `focusAreas` and restart as in step 3. Past runs are not rescored, so
nothing else needs undoing.

## Troubleshooting

| Symptom                                             | Cause                                                                        | Fix                                           |
| --------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------- |
| `focus areas must be unique` at `focusAreas`        | Two entries differ only by case                                              | Remove one                                    |
| `Too big: expected array to have <=25 items`        | More than 25 areas (the decision models allow 26 options, including `other`) | Merge areas                                   |
| `Too small: expected string to have >=1 characters` | An empty or blank entry                                                      | Delete the entry                              |
| Many items land in `other`                          | The areas are too narrow or oddly worded                                     | Use plain, broader names                      |
| More `quiet` weeks than before                      | Relevance scores moved and thresholds no longer fit                          | See [Change thresholds](change-thresholds.md) |

## Related

- [Focus areas](../../configuration/focus-areas.md), [Config keys](../../reference/config-keys.md)
- [Quiet week](../debug/quiet-week.md), [Missing or wrong item](../debug/missing-or-wrong-item.md)
- [src/classify/CLAUDE.md](../../../src/classify/CLAUDE.md)
