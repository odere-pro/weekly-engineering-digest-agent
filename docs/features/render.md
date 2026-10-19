# Render

Part of [Features](README.md).

## What it is for

This feature turns digest data into text, for three readers. People get a Markdown digest grouped
by urgency. Models and guards get a plain, fixed "canonical" text. The maintainer gets a review
sheet to tick which picks were wrong and which items were missed. It also reads a saved
`digest.md` back, so a week that was only partly delivered can be sent again.

## Where it sits

It is used throughout the run: the write step renders each draft, the judge and guards read the
canonical text, and delivery sends the view. See [data flow](../architecture/data-flow.md).

## What it does

- Builds one digest view from the winning draft. The title is computed in code, for example
  "Week 2026-W42: 5 releases, 1 needs action". Items are grouped as act now, worth a look and
  good to know, and empty groups are dropped. An item with no urgency counts as "worth a look".
- Adds a footer that names any guard that was off for the run.
- Writes the Markdown: the title, the headline, then per group a heading and a table, then the
  footer. The intro is not shown. Every channel renders the same view, so they agree.
- Keeps model text from breaking the layout. Text is put on one line, table pipes are escaped, and
  link text and destination are escaped so the link check reads back the same URL.
- Writes the canonical text: a plain, fixed form of the digest that the judge and the guards read.
  It has no options, so a layout change never moves scores or guard results.
- Reads a saved `digest.md` back into a view (and the older layout from before the urgency
  groups). A resume uses this to send the saved digest to the channels that missed it.
- Builds `review.md` for a run that has a winner: a checklist of the picked items and up to 20 of
  the best left-out items. `digest feedback <week>` reads your ticks back. It rejects an edited
  item line and names the line number. Only the tick boxes may change.
- All of it is pure: no file access, no model call.

## What you can configure

- Nothing. Titles, labels, groups and the layout are fixed in code.
- `topN` limits how many items appear. See [collection limits](../configuration/collection-limits.md).
- Which channels get the text, and where the file goes, are delivery settings. See
  [Markdown delivery](../configuration/delivery-markdown.md).
- To see the result for a saved week without sending, run `pnpm digest preview <week>`. See
  [preview a week](../runbooks/run/preview-a-week.md).

## What can go wrong

- A saved `digest.md` cannot be read back or its links differ from what was sent. The resume
  refuses and tells you to use `--force`. See
  [resume a partial delivery](../runbooks/recover/resume-partial-delivery.md).
- `review.md` cannot be written. This is only logged; the run is not affected.
- A change to the layout can change the word count or add a link-like text, and then every draft
  fails the checks. That is a code change, caught by the golden-file tests.
- The review sheet fails to parse after an edit: `digest feedback` names the line.
- To look at a stored digest, use `pnpm digest show <week> --part digest`. See
  [show a week](../runbooks/observe/show-a-week.md).

## Code and tests

- Folder: [src/render/](../../src/render/). Maintainer notes: [CLAUDE.md](../../src/render/CLAUDE.md).
- No port and no adapters. The view type is defined with the delivery port.
- Tests sit next to the code. Golden files in a fixtures folder pin the Markdown, and the same
  goldens are run through both checks.

## Related

- [write](write.md) renders each draft; [checks](checks.md) read the Markdown.
- [select](select.md) and [guards](guards.md) read the canonical text.
- [delivery](delivery.md) turns the view into a file, an email and a Slack message.
- [digest](digest.md) writes `review.md` and uses the read-back for resume.
