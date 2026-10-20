# Entries

> Turns the entries an adapter found into items and picks the ones a source keeps. `createFetcher`
> (`../pipeline.ts`) calls `readEntries`, `selectEntries` and `mergeEnriched`; `normalizeEntry`
> is the one place an `Item` is built.

## Flow

```mermaid
flowchart TD
  parsed["RawEntry[] from adapter.parse"] --> read["readEntries: normalizeEntry, then ItemSchema"]:::focus
  read -->|"threw"| warn["reportUnusable: one warning per feed"]
  read -->|"Pair[]"| select["selectEntries: distinct links, window, newest first, cap"]:::focus
  select --> pages["enrichEntries (../enrich.ts): page text for entries with none"]
  pages -->|"RawEntry[]"| merge["mergeEnriched: only the summary changes"]:::focus
  merge --> items["Item[]"]
  classDef focus stroke-width:3px
```

- An entry that throws costs that entry, not the feed. `reportUnusable` warns when entries threw,
  or when a feed had entries and none became an item: a changed date format would otherwise empty
  a feed without a trace. An entry with no usable link or date, or a link over 2048 characters,
  is left out quietly.

## Rules

- `normalizeEntry` builds every `Item`: only http(s) links and real dates get in, because the link
  check trusts what is collected. A date with a time and no zone is read as UTC.
- The link is made safe for the digest markup here (`canonicalLink`): brackets, quotes, the
  backtick, the pipe, the backslash and invisible or space characters are percent-encoded, a
  double-encoded `&amp;` becomes `&`, other character references lose their `&`, trailing
  punctuation is percent-encoded and an empty trailing `?` or `#` is dropped. Otherwise a link
  such as `.../it's-here` or `.../a)b` reaches the digest as `[title](url)`, the link check
  finds a shorter URL in it, and every draft and the fallback are rejected: the week ends
  `blocked`. Any other link keeps its bytes, so its id (a hash of the link) does not move. A link
  that is no link once safe (an IPv6 host in brackets) is left out.
- A title is cut to 300 characters and a link must be at most 2048: a guard that trims an
  over-long state keeps the head and a short tail, so padding in either would hide an
  instruction from the guards while the writer still reads it.
- Shared links are judged over the whole feed, before the window, so an entry keeps its URL and id
  from week to week while the feed repeats the link.
- The cap comes after the window and before enrichment, so pages are fetched only for kept entries.

## Files

| File                | Role                                                                     |
| ------------------- | ------------------------------------------------------------------------ |
| `types.ts`          | `RawEntry` (what an adapter's `parse` returns), `Pair`                   |
| `normalizeEntry.ts` | `normalizeEntry`, `NormalizeOptions`: link, date, title, summary, id     |
| `canonicalLink.ts`  | `canonicalLink`: the link in the form the digest markup can carry        |
| `readEntries.ts`    | `readEntries`, `reportUnusable`, `Reading`                               |
| `selectEntries.ts`  | `selectEntries`, `withDistinctLinks`: distinct links, window, order, cap |
| `mergeEnriched.ts`  | `mergeEnriched`: page text back into the items                           |

## Gotchas

- `cli/fetch/fetch.tap.test.ts` scans product code: no file here may use the word `tap` or call
  `createFetcher(`. Each file has a test that calls it directly.
