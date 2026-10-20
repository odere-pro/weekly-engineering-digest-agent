# Slack blocks

> The digest view as a Slack message, and Markdown as Slack mrkdwn. Entries:
> `toSlackBlocks(view) → SlackMessage` (`toSlackBlocks.ts`), `toSlackMrkdwn(markdown)` and
> `escapeSlack(text)` (`slackFormat.ts`). Pure: no port, no I/O.

## Flow

```mermaid
flowchart TD
  view["DigestView"] --> head["header (title) and the headline as a context block"]
  view --> body["bodyBlocks: a bullet per item, packed into sections, a divider between groups"]
  body --> fit["fitBlocks: 50 blocks in all, the last body slot says what was cut"]
  head --> out["SlackMessage: text for notifications, blocks"]
  fit --> out
  md["Markdown: no view, or a failure line"] --> strip["visibleText: invisible characters out, line breaks stay"]
  strip --> mrkdwn["toSlackMrkdwn: escape, headings and ** to bold, links to Slack links"]
```

## Rules

- All text is escaped (`& < >`) before Slack reads it, so `<!channel>` or `<@U123>` cannot appear.
  Only http(s) URLs without a user name or password become links; `|` in a URL is encoded.
- Limits: 50 blocks, 3,000 characters a section, 150 in the header. Each field has its own budget,
  counted after escaping. The cut is made on the raw text, so `&amp;` is never split.
- No header or context block is empty: Slack rejects the whole message for one.
- Text is one line (`oneLine` over `visibleLine`): control and invisible format characters (bidi
  overrides and marks, zero-width, tag) become a space, so a feed cannot reorder or hide what is
  shown. A joiner between two emoji stays, so a joined emoji arrives whole; email follows the same
  rule. A backtick becomes an apostrophe, so no code fence swallows later bullets.
- `toSlackMrkdwn` (the no-view and failure paths) keeps the Markdown's own line breaks, so it uses
  `visibleText` (`render/visibleText`), not `visibleLine`: the same characters and the same
  emoji-joiner rule, but `\n` stays, indentation stays and each line loses its trailing blanks. It
  runs before the escaping, so the headings, bold and links are read from clean text.
- Pure: the same view gives the same message, and each divider is a new object.

- `view.variant` is a header suffix; `view.appendix` is a divider, a heading and one section per area
  after the groups, all inside the same 50-block cap (`fitBlocks` cuts and says so).

## Files

| File               | Role                                                                    |
| ------------------ | ----------------------------------------------------------------------- |
| `toSlackBlocks.ts` | `toSlackBlocks`, `SlackBlock`, `SlackMessage`: the blocks and their fit |
| `slackFormat.ts`   | `escapeSlack`, `toSlackMrkdwn`: Markdown to mrkdwn                      |

Tests sit next to each file. `__fixtures__/` has `digest-view.json` and its golden
`digest-blocks.json`; `slack.test.ts` reads the view too.

## Gotchas

- Edit `digest-blocks.json` by hand: there is no update switch. Read the diff of a layout change.
- `SlackBlock` has four kinds (header, context, section, divider): a new kind needs the union and
  the Slack limits checked.
