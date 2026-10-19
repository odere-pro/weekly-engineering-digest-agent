# Doctor .env checks

## Intent

Looks at the `.env` file without ever showing what is in it. It tells the user when other users can
read the file, and when node's `.env` parser silently cut a value at a `#`.

## How it works

1. `checkEnvFile` stats the file. Mode with no group or other bits: ok. Any of them set: a warning
   with the mode in octal and `chmod 600 .env`. A missing file is ok (secrets can come from the
   process environment). Any other error is a warning with the reason.
2. `checkEnvValues` reads the file and calls `keysCutAtHash`. No cut value: ok. Cut values: one
   warning that names each key and its line, with a fix that says to quote the value.
3. `keysCutAtHash` scans line by line like `node:util` `parseEnv`. An unquoted value ends at its
   first `#`. A quoted value ends at the next same quote, on a later line if need be. A quote that
   nothing closes stays plain text. It returns `{ key, line }` for the first line of each key.

## Design

- Only the key and the line number leave the scan. The value is never copied into a result, a
  message or a log. A test checks that.
- The scan copies the parser's rules, including multi-line quotes, so it never skips a line the
  parser reads or reads one it skips.
- A missing file gives no `.env values` line, since the `.env` line already says it is missing.

## Files

| File                    | Role                                                               |
| ----------------------- | ------------------------------------------------------------------ |
| `envFile.ts`            | `checkEnvFile`, `checkEnvValues`                                   |
| `keysCutAtHash.ts`      | `keysCutAtHash`: the scan                                          |
| `envFile.test.ts`       | The two checks, direct and through `doctorCommand`                 |
| `keysCutAtHash.test.ts` | Quotes, comments, `export`, CRLF, multi-line values, repeated keys |

## Depends on, used by

Depends on: `report/checkResult`, `errorCode.ts`, `shared/errors`, the `stat` and `readFile` slice
of `DoctorIo`.
Used by: `doctor.ts`.

## Change it safely

- Run `pnpm vitest run src/cli/doctor/envFile`.
- If the loader's `.env` parser changes (`config/load.ts`), check `keysCutAtHash` against it.
- Never add the value to a message, even in part.
