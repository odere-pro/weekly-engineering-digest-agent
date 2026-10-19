# Fact carry

Part of [Metrics](README.md).

## What it measures

The share of shipped digest items whose versions, CVE and GHSA ids and dates are all in the item
they came from. The title, the summary and the action line are each checked.

## Why it matters

A reader acts on a version number or a CVE id. The link check and the format check look at the form
of the digest, not at its facts. The grounding guard is the only check on facts, it is measured on
planted drafts only, and it never reads the item title, which the writer writes with a version in it.
This metric compares the text a reader gets with its source, so a model that changes `v1.31` to
`v1.32` shows up even when every other layer let it through.

## How it is computed

`factCarry` in `evals/metrics/digest/factCarry.ts`, over the six plain week replays (not the attack
replay). The fact reader is `factTokensOf` in `src/write/provenance/factTokens.ts`.

1. `parseDigestMarkdown` reads the written Markdown back. Each item is matched to its collected item
   by URL. An item whose link matches none is skipped: [link validity](link-validity.md) covers it.
2. A fact is a dotted version (`v1.2.0`, two to four numbers, with a pre-release such as `-rc.1`,
   `-beta`, `rc1` or `b1`), a CVE id, a GHSA id or an ISO date (`2026-10-19`). Facts are
   lowercased and a leading `v` is dropped, so `v1.2.0` in the digest and `1.2.0` in the source
   are the same fact. `2.0.0-rc.1` and `2.0.0` are not. A name after the number is not part of it:
   `gpt-4.1-mini` holds the fact `4.1`.
3. The facts of the title, the summary and the action line are looked up in the title and the summary
   of the collected item. A fact that is not there is a miss, with one exception: a shorter form of
   a plain version in the source is present. `1.31` is not a miss for a source `v1.31.2`, and `1.31`
   and `1.31.2` are not misses for `1.31.2.1`. A pre-release must match exactly: for a source
   `1.17.0-beta1`, both `1.17` and `1.17.0` are misses, because they would announce the beta as the
   release. The writer's title repair (`groundTitle`) calls the same function, so the pipeline and
   the metric agree on what a wrong fact is.
4. The value is shipped items with no miss divided by shipped items checked. An item counts once,
   however many facts it gets wrong.

Each miss is a line in `byWeek`, naming the part, the item title, the fact and the layers that let it
through: `title of "tool v1.3.0": 1.3.0 is not in its source; got past linkCheck, formatCheck,
graniteGroundedness, clefRubric`. The layers are the link check, the format check and every output
guard that was not switched off in the run. `byWeek` keeps the first 5 lines of a week.

A week with no digest is left out of the value. It shows as `no-digest` and the note names it.

## The gate

- Soft, at least 1 (100%). No judge rule.
- A miss shows `FAIL` on the scorecard and does not change the exit code. The gate stays soft until
  a baseline shows how far the writers are from 100%.
- Fewer than 6 weeks gets the note "only N of 6 weeks"; the verdict stays. See [gates](../gates.md).

## Data it uses

The [recorded weeks](../sets/recorded-weeks.md): the digest of each plain week replay and the items
that replay served.

## How to add a case

The check runs on every digest, so coverage grows with the recorded weeks. A change to what counts
as a fact, or to the shorter-version rule, is a code change in `src/write/provenance/factTokens.ts`;
its test pins each shape and checks that a long hostile string is read in linear time.

## Limits

- Only the title and the summary of the source are searched, not its URL or the linked page.
- Each item is checked against the one collected item its link names. The writer may fold a
  duplicate into one entry; a fact it takes from the folded item is a miss.
- A version written in words, a date such as "Oct 6" or a number without a dot is not a fact here.
  Any number with a dot is: `99.9` or `2.5x` count as a version.
- The shorter-version rule holds for the summary and the action line too. A source that says
  "fixed in 1.31.2" lets the action "Upgrade to 1.31" pass; that is by design.
- A pre-release is known by its word (`alpha`, `beta`, `preview`, `pre`, `rc`, `dev`, `snapshot`,
  `nightly`, `canary`) or a glued `a`/`b` and number. Any other suffix, such as `2.0.0-next.3`, reads
  as the plain version `2.0.0`.
- A longer version than the source's (`1.31.3` for `1.31.2`, `1.31.2` for `1.31`) is a miss, and so
  is a version that is not a shorter form at a dot (`1.3` for `1.31.2`).
- The headline is not checked.

## Current result

Current result: none yet. The metric was added after the newest scorecard (2026-10-18, profile
light). See [results](../results.md#fact-carry).
