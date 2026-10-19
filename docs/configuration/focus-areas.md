# Focus areas

Part of [Configuration](README.md).

Focus areas are the topics your team cares about. The agent sorts every collected item into one
of them (or into `other`) and tells the writers and the judge what the reader is interested in.

| Key          | Type             | Default  | Limits                                  |
| ------------ | ---------------- | -------- | --------------------------------------- |
| `focusAreas` | array of strings | required | 1 to 25 entries, unique, each non-empty |

```json
{
  "focusAreas": ["AI models and tooling", "Platform engineering", "Cloud services"]
}
```

## Rules

- Each entry is trimmed. Blank entries are refused.
- Entries must be unique, ignoring case. `Platform` and `platform` count as the same area.
- The most you can list is 25. The classifier asks a multiple-choice question over your areas plus
  `other`, and the decision model allows 26 options.
- `digest init` offers `AI models and tooling` and `Platform engineering`, and lets you add more.

## What they change

| Step     | Use of `focusAreas`                                                               |
| -------- | --------------------------------------------------------------------------------- |
| classify | The choices for the `area` question: your areas plus `other`                      |
| process  | The area spread: at most 2 items from one area while another area still has items |
| write    | The writer prompt says which topics the reader cares about                        |
| select   | The judge scores `focusFit` against these areas                                   |

The models read the exact text of each area, so write it as a short phrase a person would say,
such as `AI models and tooling`, rather than a code word.

A source can carry its own `area` hint. It is only a hint for the classifier and does not have to
match a focus area. See [sources](sources.md).

## What they do not change

- The feeds you collect from. Changing an area does not add or remove a source.
- Saved runs. Old `scores.json` files keep the area names they were written with.

The new list applies to the next run. A running `serve` process needs a restart first
([the config file](config-file.md#when-a-change-takes-effect)).

## Change it

- [Change the focus areas](../runbooks/configure/change-focus-areas.md)
- [Add a source](../runbooks/configure/add-a-source.md) when a new area needs new feeds

## Related

- [Thresholds](thresholds.md): `minRelevance` decides how relevant an item must be.
- [Classify feature](../features/classify.md) and [process feature](../features/process.md)
- [Glossary](../reference/glossary.md)
