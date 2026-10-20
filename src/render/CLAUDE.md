# Render

> Pure views of a digest: a `DigestView` and its Markdown for readers, fixed "canonical" text for
> the judge and guards, a review sheet for the maintainer. It reads a saved `digest.md` back so a
> part-delivered week can resume. Not a chain step, no port.
> Entry: `buildDigestView(digest, options) → DigestView` (`layout.ts`).

## Context

```mermaid
flowchart LR
  render:::focus -->|"Markdown"| write
  render -->|"canonical text"| guardOutput & select
  render -->|"DigestView"| digest["digest: ending/shipping, resumeDelivery"] -->|"DigestMessage"| deliver
  render -->|"review sheet"| ending["digest: ending/runFiles"] -.-> store[[RunStore]]
  render -->|"view, Markdown, ReviewFeedback"| cli["cli: preview, feedback"]
  render -->|"renderDigest, readSavedView"| evals["evals: metrics/digest, evalKit"]
  classDef focus stroke-width:3px
```

## Flow

```mermaid
flowchart TD
  digest[Digest] --> view["buildDigestView: title, groups by urgency, footer"]
  view --> md["renderView: Markdown, one table per group"]
  md --> file["digest.md"]
  file -->|"readSavedView, readSavedDigest"| back["DigestView, or headline and urls"]
  digest --> canon["canonicalDigestText, canonicalClaimText, canonicalHeadlineText"]
  canon --> models["judge and output guards"]
  picks["Item[], Classification[], picked ids"] --> sheet["buildReviewSheet"]
  sheet --> review["review.md"] -->|"user ticks, parseReviewSheet"| fb["ReviewFeedback"]
```

- The view has a title computed in code ("Week 2026-W42: 5 releases, 1 needs action"), the model's
  headline, groups in order act-now, worth-a-look, good-to-know (empty ones dropped) and a footer:
  the template-digest note, then the guards that were off. No `urgency` counts as worth-a-look.
- Markdown: `# title`, `_headline_`, then per group `## <marker> <label>` and a table, then `---`
  and the footer. Good-to-know has no action column. The intro is not shown.
- `readSavedDigest` (`{ headline, urls }`) also reads the layout before urgency (`# headline`,
  `[Source](url)` lines), so a week part-delivered across an upgrade resumes.

- A view may carry a `variant` label (`enriched`, `perspective: security`) and an `appendix` (every
  release of the week by area). `buildAppendix(items)` takes title and line from the item's own text
  (`sourceLine.ts`: `plain`, `cutSummary`, `titleOf`, moved from `write/fallbackDigest`; it uses
  `sourceText.ts`, `safeSourceText`), never model text. `renderAppendix` writes `## Everything this
week`, `### <area>` and `- [title](url): line`, escaped as a table item is. `renderView` does not
  draw either: the Markdown caller appends the appendix, each channel renders its own.

## Rules

- Pure: no I/O, no model call, inputs unchanged. Titles, labels and the footer come from code.
- Model text must not break a table, hide a link or reorder what is read: `cell` makes it one line
  with `visibleLine` (invisible characters become a space) and escapes pipes; link text and
  destination get the same and are escaped so `linkCheck` decodes the same URL. A hidden character
  in a destination breaks its link, so the draft is rejected. A blank title shows the URL.
- Model and feed text must not be markup either (CON-3): `<` and `>` get a backslash in a cell, the
  link text, the destination and the headline line, so `<svg onload=...>`, `<img ...>` and
  `<javascript:...>` stay text in a viewer that lets HTML through (CommonMark shows `\<` as `<`).
  A backslash run before such a character (or a pipe) is doubled and one added, so the count is
  odd and the text shows as written. Title, group labels and footer come from code, unescaped.
- Reading back undoes exactly what rendering escapes and never throws: an odd run before `|`, `<`
  or `>` loses half its length and the character's own backslash; an even run (not written by the
  renderer) and a raw bracket from a file saved before the escapes read as they stand. A group's
  urgency comes from its marker, the label as written; an unknown heading is skipped.
  `withoutHeading` drops an action's repeat of its column heading; it is not restored.
- Canonical text takes no options: scoring and guard input stay the same whatever the template.
- Review sheet: no model call. Titles are cut to 120 characters, Markdown specials escaped, unsafe
  URL characters percent-encoded. The parser rejects an edited line, a duplicate id or a missing
  section.

## Files

| File             | Role                                                                            |
| ---------------- | ------------------------------------------------------------------------------- |
| `digestView.ts`  | `DigestView`, `DigestViewGroup`, `DigestViewItem`: the view every channel shows |
| `layout.ts`      | `buildDigestView`: grouping, labels, title, footer                              |
| `markdown.ts`    | `renderView`, `renderDigest`, `readSavedView`, `readSavedDigest`, escaping      |
| `visible*.ts`    | `visibleLine`, `visibleText`: invisible characters out; delivery uses them too  |
| `canonical.ts`   | `canonicalDigestText`, `canonicalClaimText`, `canonicalHeadlineText`            |
| `reviewSheet.ts` | `buildReviewSheet`, `parseReviewSheet`, `MAX_CANDIDATES`                        |

Tests sit next to each file; `__fixtures__/render/` holds five digests with `.golden.txt` goldens
(Prettier rewrites table pipes in `.md`). `html` is the one with `<` and `>` in every field.

## Gotchas

- The marker, the title shape and the table layout are the saved-file format: `TITLE_LINE` (`markdown.ts`)
  must match `titleOf` (`layout.ts`), and resume must find the item URLs in `digest.md` (rows start
  `| [`) or it refuses until `--force`. If the rebuilt view no longer renders to the file (a `digest.md`
  saved with hidden characters before `visibleLine`, or with a raw `<` before the escapes), channels
  get the Markdown without the view and their adapters clean it. Change writer and reader as one.
- `checks/` counts the Markdown (under 500 words) and reads its links, so template words, links or
  an em dash can fail every draft. `markdown.fixtures.test.ts` runs both checks on the goldens.
- Changing canonical text changes judge and guard input; eval baselines stop comparing. It keeps the
  writer's characters on purpose, so the guards see what was hidden: only the Markdown is cleaned.
- Review `rank` is the position in `scores.json`, which `classify` writes in collect order (newest
  first), not by relevance. The 20 candidates are the first left-out items in that order.
