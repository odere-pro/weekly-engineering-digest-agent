# Render the digest

## Intent

Turns digest data into text, for three readers. People get a Markdown digest grouped by urgency.
Models and guards get a plain, fixed "canonical" text. The maintainer gets a review sheet to tick
which picks were wrong and which items were missed. This folder also reads a saved `digest.md`
back, so a week that was only partly delivered can be sent again.

## How it works

1. `buildDigestView(digest, { disabledGuards })` (`layout.ts`) makes a `DigestView`: a title
   computed in code ("Week 2026-W42: 5 releases, 1 needs action"), the model's headline, groups
   ordered act-now, worth-a-look, good-to-know (empty groups dropped), and a footer naming any
   guards that were off. An item without urgency counts as worth-a-look.
2. `renderView(view)` (`markdown.ts`) writes `# title`, `_headline_`, then per group a
   `## <marker> <label>` heading and a table, then `---` and the footer if there is one.
   `renderDigest` does both steps. The intro is not shown.
3. `canonicalDigestText(digest)` (`canonical.ts`) is the text the judge and guards read.
   `canonicalClaimText(item)` and `canonicalHeadlineText(digest)` feed the groundedness guard.
4. `readSavedView(markdown)` reads a digest in the current layout back into a `DigestView`, or
   returns `undefined`. `readSavedDigest(markdown)` returns `{ headline, urls }` and also reads
   the layout before W8-02 (`# headline` and `[Source](url)` lines).
5. `buildReviewSheet({ weekId, items, classifications, pickedIds })` writes a checklist of picked
   items and up to `MAX_CANDIDATES` (20) best left-out items. `parseReviewSheet(text)` returns
   `{ weekId, wrongPicks, missed }` for `digest feedback <week>`.

## Design

- Layout and Markdown are two steps. Every channel renders the same `DigestView` (its type lives
  in `delivery/Delivery.ts`). Titles, labels and the footer come from code, never from a model.
- Everything here is pure: no I/O, no model call, inputs are not changed.
- Model text must not break the table or hide a link. `cell` puts text on one line and escapes
  pipes (a backslash run before a pipe is doubled). Link text and destination are escaped so that
  `linkCheck` decodes the same URL back. A blank title shows the URL.
- Reading back undoes exactly what rendering escapes, and never throws. The urgency of a group is
  found from its marker character; the label is read as written. A heading it does not know is
  skipped. Regexes use lookbehinds so a long run of backslashes is read in linear time.
- `withoutHeading` drops a repeated "Relevant if you" from an action, because the column heading
  already says it. The reader does not put it back.
- Canonical text takes no options on purpose. Scoring and guard results stay the same whatever
  the template looks like. An item with no urgency or action reads as it did before W8.
- Review sheet: no model call. Titles are cut to 120 characters and every Markdown special is
  escaped. URLs are percent-encoded where unsafe. The parser rejects an edited item line and names
  the line number. Only the tick box may change.

## Files

| File             | Role                                                                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `layout.ts`      | `buildDigestView`: grouping, labels, title, footer                                                                                       |
| `markdown.ts`    | `renderView`, `renderDigest`, `readSavedView`, `readSavedDigest`, escaping                                                               |
| `canonical.ts`   | Plain text for the judge and guards                                                                                                      |
| `reviewSheet.ts` | `buildReviewSheet`, `parseReviewSheet`, `MAX_CANDIDATES`                                                                                 |
| `*.test.ts`      | `layout`, `markdown`, `markdown.escaping`, `markdown.read`, `markdown.fixtures`, `canonical`, `canonical.urgency`, `reviewSheet`         |
| `__fixtures__/`  | `render/`: four digests (`mixed`, `old-draft`, `quiet-week`, `escaping`) with `.golden.txt`, and `cells.ts`; `feedback/review.golden.md` |

## Depends on, used by

Depends on: `domain` (types), `delivery/Delivery` (the `DigestView` types only), `shared`
(`DigestError`, `truncate`).
Used by: `write` (`renderDigest`), `select` and `guards` (canonical text), `digest` (view, render,
read-back, review sheet), `cli/preview` and `cli/feedback`, `evals` (`renderDigest`, `readSavedView`).

## Change it safely

- Run all of `src/render/`. `markdown.fixtures.test.ts` compares goldens and also runs the link
  check and the format check on them. Goldens are `.golden.txt` because prettier rewrites table
  pipes in `.md` files.
- Change a writer and its reader together. The round trip test in `markdown.read.test.ts` must
  stay green, and `TITLE_LINE` must match what `titleOf` writes.
- Do not change a group marker or the title shape without a plan for saved files. Old files then
  read as the legacy layout or lose a group.
- The Markdown is what the format check counts (under 500 words) and the link check reads. Added
  words, links or an em dash in the template can fail every draft.
- A change to canonical text changes judge and guard input. Eval baselines no longer compare.
