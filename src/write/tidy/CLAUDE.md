# Tidy

> Fixes the two text faults writers copy from feeds: em dashes and a title that says its release
> tag twice. Entries: `withoutEmDashes(text)` (`emDashes.ts`), `tidyTitle(item)` (`title.ts`).

## Flow

```mermaid
flowchart TD
  title["tool v1.2.0: Release v1.2.0"] --> colon{"first colon, head and tail not empty?"}
  colon -->|no| same[title unchanged]
  colon -->|yes| words["comparableWords(head), comparableWords(tail)"]
  words --> new{"a tail word not in the head and not filler?"}
  new -->|yes| same
  new -->|no| head["the head: tool v1.2.0"]
```

- `comparableWords` lowercases and splits at spaces and `, ; : ( ) [ ]`, drops closing dots and a
  `v` before a digit, so `v1.2.0.` and `1.2.0` are the same word.
- `withoutEmDashes` turns a run of em dashes, with the spaces and commas around it, into one
  comma; at the start or end of the text the run is dropped.

## Rules

- A title that says something new after the colon is never changed, and only the first colon counts.
- Filler words (`release`, `released`, `version`, `tag`, `v`) add nothing next to a version.
- `withoutTrailingDots` is a loop, not `/\.+$/`: that pattern is quadratic on a long run of dots,
  and the title is model output. `title.test.ts` checks the run time.
- Both return new values and change nothing they were given.

## Files

| File               | Role                                                                            |
| ------------------ | ------------------------------------------------------------------------------- |
| `emDashes.ts`      | `withoutEmDashes`                                                               |
| `title.ts`         | `tidyTitle`, `collapseRestatedTag`, `comparableWords`, `withoutTrailingDots`    |
| `emDashes.test.ts` | Runs, ends of the text, text that must stay as it is                            |
| `title.test.ts`    | Collapsing and not collapsing, the words compared, dots, speed on hostile input |

## Gotchas

- The format check rejects em dashes and the write prompt asks for none; this is the backstop.
- A wider collapse rule can hide a real difference between two releases. Add a "leaves it alone"
  case with every new rule; `write.test.ts` runs the same cases through `writeStep`.
