# Scorecard text

> The scorecard `digest eval` prints, as plain text, and the table cells `compare/` reuses.
> Entry: `formatScorecard(scorecard) → string` (`formatScorecard.ts`). Pure: no I/O, no model, no port.

## Flow

```mermaid
flowchart TD
  card["SavedScorecard"] --> head["header: profile, day, partial note, case counts, judge agreement"]
  card --> tbl["table: valueCell, gateCell, resultCell"]
  card --> blocks["blocks in this order, each printed only when it has lines"]
  blocks --> det["Details: per-guard numbers"] --> wk["Week problems: weekProblemLines"]
  wk --> ids["Item ids by run: itemIdsByRunLines"] --> notes["Notes"]
  head & tbl & notes --> verdict["Hard gates: PASS, or FAIL with the metric ids"]
```

## Rules

- Text a model or a feed wrote goes through `safeText` or `oneLine` before it is printed: control,
  C1, line and paragraph separator, zero-width, bidi and tag characters become one space. A hostile
  feed must not move the cursor, recolor the terminal or reorder what is read.
- A link that matched no collected item prints as `unmatched`, never its URL: a model wrote it.
- Only the first 3 problems of a week are printed, then "... N more": the scorecard file keeps the
  rest, up to what it stored. A week with status `ok` is left out.
- `cells.ts` serves the compare table too: a change there changes both outputs.

## Files

| File                 | Role                                                                       |
| -------------------- | -------------------------------------------------------------------------- |
| `formatScorecard.ts` | `formatScorecard`: header, table, blocks, verdict; `detailText`, `section` |
| `cells.ts`           | `valueCell`, `gateCell`, `resultCell`, `table`: the aligned table          |
| `weekProblems.ts`    | `weekProblemLines`, `MAX_PROBLEMS_SHOWN`: failed and empty weeks           |
| `itemIds.ts`         | `itemIdsByRunLines`, `ITEM_IDS_TITLE`: short ids per run                   |
| `printable.ts`       | `safeText`, `oneLine`, `plural`, `MAX_PRINTED_PROBLEM_CHARS`               |

Each file has its test beside it; scorecards come from `../__fixtures__/scorecardKit.ts`.

## Gotchas

- `UNSAFE_TEXT` lets some invisible characters pass: U+061C (a bidi control), U+2060 to U+2064,
  U+206A to U+206F, U+FEFF, U+00AD. Widen the regex and `printable.test.ts` together.
- Tests pin the exact lines, spacing and the "(judge)" and "reported" gate words. A new metric
  needs no code here: it prints from `METRIC_IDS` and the `MetricResult` fields.
