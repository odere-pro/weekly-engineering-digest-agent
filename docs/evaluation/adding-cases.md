# Adding cases

Part of [Evaluation](README.md).

How to add data to each eval set, and the rules the tests enforce. The data lives in `evals/` and
is read by `loadEvalCases` in `evals/runEval.ts`. Each set has its own page with the details.

| Set                                            | Where it lives                             | Add one by                              |
| ---------------------------------------------- | ------------------------------------------ | --------------------------------------- |
| [Recorded weeks](sets/recorded-weeks.md)       | `evals/weeks/<week>/`                      | `pnpm eval:record`, then label by hand  |
| [Classifier cases](sets/classifier-cases.md)   | `evals/classifier-cases.json`              | a new entry in `cases`                  |
| [Attacks](sets/attacks.md)                     | `evals/attacks/attack-NN-<kind>.json`      | a new file and a row in its `README.md` |
| [Grounding](sets/grounding.md)                 | `evals/grounding/grounding-NN-<name>.json` | a new file and a row in its `README.md` |
| [Source recordings](sets/source-recordings.md) | `evals/sources/<source id>/`               | `pnpm tsx evals/recordSources.ts`       |

## Rules for every set

- **Ids are hashes.** An item id is the first 16 hex characters of the SHA-256 of the normalized
  URL (`itemIdFor` in `src/shared/url.ts`). The tests check it. To get one:

  ```bash
  pnpm exec tsx -e "import { itemIdFor } from './src/shared/url'; console.log(itemIdFor('https://acme.example/post'))"
  ```

- **Fake cases use `.example` hosts.** Companies, products and URLs in attacks, grounding drafts
  and synthetic classifier items are invented, so no real site is ever contacted or named.
- **People own the labels.** The recorders never overwrite `labels.json` or `expected.json`.
  A model may propose labels; the maintainer reviews them.
- **Recorded feed bodies are untrusted text.** Read them. Never run them.
- **Changing `normalizeUrl` means re-recording**, because every id in the data depends on it.
- **Held-out cases are off limits for tuning.** Attacks `attack-21` to `attack-30` and grounding
  cases `grounding-21` to `grounding-30` carry `"heldOut": true` and must never be used to tune a
  guard prompt, a rule or a threshold. Do not read them while you tune. Add new cases instead.
  Cases `attack-11` to `attack-20` were held out once and are now a regression set. Attacks 21 to 30
  are written by `evals/attacks/mutate.ts`. See [attacks](sets/attacks.md) and
  [grounding](sets/grounding.md).

## What the tests check

Run `pnpm vitest run evals` after every change. No test calls a model. The `dataset.*.test.ts`
files fail with a message that names the broken file.

| Test file                                 | Checks                                                                                   |
| ----------------------------------------- | ---------------------------------------------------------------------------------------- |
| `evals/dataset.labels.test.ts`            | 5 unique must-include ids per week, ids exist in `items.json`, review note present       |
| `evals/dataset.classifierCases.test.ts`   | 60 cases, whole relevance 0 to 3, area known, balance, real items unchanged              |
| `evals/dataset.cases.test.ts`             | 30 attacks and 30 grounding drafts: technique, uniqueness, README rows, `heldOut`, hosts |
| `evals/dataset.sources.test.ts`           | every default source has a recording, `reviewed: true`, fetcher output matches           |
| `evals/schema.test.ts`, `runEval.test.ts` | the zod schemas and the loader (duplicate ids, items outside their week)                 |

The loader also stops a run when a week item was not published in its ISO week, when a label names
an id that is not in `items.json`, or when an attack shares an id or URL with a week item.

## The set sizes are fixed in the tests

The tests expect exactly 6 weeks, 30 attacks, 30 grounding drafts and 60 classifier cases. The hard
gates need only 6 weeks, 10 attacks and 10 grounding cases (`SPEC_EVAL_SET`, see [gates](gates.md)),
so the data is above the minimum. To grow a set, a maintainer changes the constant in the test next
to the data. A bigger set also makes `digest eval` slower: each week costs three replays, and every
attack and grounding case costs model calls. The saved scorecard (2026-10-18) used 20 attacks and
10 grounding drafts; the next one will use 30 and 30.

## After you add data

1. Run `pnpm vitest run evals`, then `pnpm check`.
2. Run `digest eval` and read the new scorecard ([re-baseline the evals](../runbooks/maintain/re-baseline-evals.md)).
3. Update the counts on the set page and on [results](results.md).

To turn a bad real week into a case, see
[add an eval case from a bad week](../runbooks/maintain/add-eval-case-from-a-bad-week.md).
