# Doctor .env checks

> Looks at the `.env` file without showing what is in it: warns when other users can read it, and
> when node's `.env` parser silently cut a value at a `#`. Entries: `checkEnvFile(io)` and
> `checkEnvValues(io)` (`envFile.ts`).

## Flow

```mermaid
flowchart TD
  stat["checkEnvFile: stat the file"] --> mode{"group or other bits set?"}
  mode -->|no| ok1["ok: readable only by you"]
  mode -->|yes| w1["warn: mode in octal, fix chmod 600 .env"]
  stat -.->|"missing"| ok2["ok: secrets can come from the environment"]
  read["checkEnvValues: readFile"] --> scan["keysCutAtHash: key and line of each cut value"]
  scan --> cut{"any?"}
  cut -->|no| ok3["ok"]
  cut -->|yes| w2["one warning naming each key and line; fix: quote the value"]
```

## Rules

- Only the key and the line number leave the scan; the value is never copied into a result, a message
  or a log. A test checks that.
- `keysCutAtHash` copies the parser's rules (`node:util` `parseEnv`): an unquoted value ends at its
  first `#`; a quoted value ends at the next same quote, on a later line if need be; a quote that
  nothing closes stays plain text. So it never skips a line the parser reads.
- A missing file gives no `.env values` line: the `.env` line already says so. Any other read error
  is a warning with the reason.

## Files

| File               | Role                             |
| ------------------ | -------------------------------- |
| `envFile.ts`       | `checkEnvFile`, `checkEnvValues` |
| `keysCutAtHash.ts` | `keysCutAtHash`: the scan        |

`keysCutAtHash.test.ts` covers quotes, comments, `export`, CRLF, multi-line values and repeated keys.

## Gotchas

- If the loader's `.env` parser changes (`config/load.ts`), check `keysCutAtHash` against it.
- Never add the value to a message, even in part.
