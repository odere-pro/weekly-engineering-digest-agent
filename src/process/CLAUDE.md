# Process

## Intent

Classify scores every item, but the digest has room for only 3-5. This step decides which items
go to the writers. It removes items sent in earlier weeks, duplicates, low-relevance items, hype
and minor releases, then picks the top N with a spread across areas. It is plain code with no
model call, so the same input always gives the same answer.

## How it works

1. `processStep({ items, sentUrls, thresholds, topN })` (`process.ts`) is a synchronous function.
   It throws `DigestError` (step `process`) unless `topN` is a whole number of 0 or more.
2. With `calibration` in the input, each item's relevance is first replaced by the calibrated score
   (`calibration.ts`: a monotone map plus a per-area bias, fitted offline by `evals/calibrate.ts`).
   Without it the items pass through untouched. Then it ranks all items once with `byRank`: relevance high first, then `areaConfidence`, then
   newest `publishedAt`, then id. Source, title and URL only settle ties between equal ids.
3. `filterStages` drops items in a fixed order. An item gets the first reason that fits:
   `sent-before`, `duplicate`, `low-relevance` (below `minRelevance`), `hype` (above `maxHype`),
   `minor-release` (above `maxMinorRelease`).
4. `pickWithAreaSpread` chooses up to `topN` from the rest. An area gets at most 2 slots
   (`MAX_SLOTS_PER_AREA`) while another area still has an item. When every area is full, the
   least-filled area goes first, then rank.
5. It returns `selected` in rank order and `dropped` as `{ itemId, reason }`. The reasons come
   in stage order, then `below-top-n` for items that survived but missed the cut.

## Design

- `sent-before` compares with `normalizeUrl` on both sides, so a tracked URL in an old run record
  still matches. It runs before `duplicate`, so a sent copy cannot hide a fresh one.
- `duplicate` runs before the threshold filters. A filtered winner takes its story with it.
  An entry repeats a better-ranked one when it has the same id, or, from a different source,
  the same normalized title or the same release key.
- The release key (`releaseKeyOf`) is `product@version` from the title, for example a blog post
  and a GitHub release of the same tag. It applies only when the rest of the title announces the
  release and names no other version. It is narrow on purpose: a missed merge is left to the
  writer, a wrong merge drops real news. Two items of the same source are never merged.
  Blank keys never match.
- Thresholds come from the input, not from constants. Defaults live in `config/schema.ts`:
  `minRelevance` 1.5, `maxHype` 0.6, `maxMinorRelease` 0.75, `topN` 5 (allowed 3-5).
- Deterministic and pure: input order does not matter, inputs are not mutated, and strings
  compare by code unit (`compareStrings`), so the machine's locale does not matter.
- The version regex must stay safe on hostile titles. A test checks that long titles stay fast.
- Fewer than `topN`, or none, is fine. The digest run decides the week is quiet when fewer than
  `DIGEST_MIN_ITEMS` (3) are selected.

## Files

| File                  | Role                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------- |
| `process.ts`          | `processStep`, `ProcessInput`, `ProcessOutput`; ranking, filters, duplicate and release matching, area spread |
| `calibration.ts`      | `CalibrationSchema`, `calibrateClassification`: the calibrated relevance on the 0-3 scale                     |
| `calibration.test.ts` | Schema, interpolation, bias, monotone, process with and without it                                            |
| `process.test.ts`     | Drop reasons, sent-before, duplicates, same release, ranking, top N, area spread, determinism                 |

There is no `__fixtures__/` here. Tests build items with `makeScoredItem` from `test/builders.ts`.

## Depends on, used by

Depends on: `domain` (`ScoredItem`), `config/schema` (`Thresholds` type), `shared` (`errors`, `url`).
Used by: `digest/runDigest.ts` (the `process` stage, which also reads `store.sentUrls`), and
`evals/` (`rescoreReplay`, `tuneThresholds`, `thresholds/sweep` mirrors its three rules).

## Change it safely

- Run `pnpm vitest run src/process`. Coverage:
  `pnpm vitest run --coverage --coverage.include='src/process/process.ts'`.
- The drop-reason order is a contract. The digest run computes `counts.afterProcess` as
  `selected` plus the `below-top-n` drops, so keep `below-top-n` as the last reason.
- If you change a threshold rule, also change `evals/thresholds/sweep.ts`, which repeats it.
- Add a failing test for any new duplicate case before touching `releaseKeyOf`. Wrong merges are
  worse than missed merges.
- Keep it pure: no model, no `node:fs`, no clock, no network.
