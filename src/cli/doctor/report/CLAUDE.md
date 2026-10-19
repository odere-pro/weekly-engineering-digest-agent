# Doctor report

## Intent

Everything doctor prints. A check returns a `CheckResult`; this folder turns a list of them into
the lines on screen, the summary and the exit code. It also holds the helper that removes
credentials from URLs, which `--readiness` uses too.

## How it works

1. A check builds its result with `ok`, `warn` or `fail` (`checkResult.ts`).
2. `report(results, stdout, secrets)` formats each result with `formatResult`: the symbol (`✓`,
   `!`, `✗`), the label and the first line of the message. Later message lines are indented. A
   warning or an error adds a `fix:` line.
3. It adds a blank line and `summary(errors, warnings)`.
4. The whole text goes through `redactSecrets` and `withoutUrlCredentials`, then to `stdout`.
5. It returns `EXIT_FAILED` (1) if any result is an error, else `EXIT_OK` (0). Warnings never fail.

## Design

- Redaction runs on the finished text, so no check has to remember it. A secret or a `user:pass@`
  in an Ollama error or a feed error cannot reach the terminal.
- `fix` shows only for warnings and errors. An ok result never prints one.
- Exit codes are public. `exitCodes.ts` is the one home for them in this feature.

## Files

| File                       | Role                                                              |
| -------------------------- | ----------------------------------------------------------------- |
| `checkResult.ts`           | `CheckResult`, `Severity`, `ok`, `warn`, `fail`                   |
| `report.ts`                | `report`, `formatResult`, `summary`                               |
| `withoutUrlCredentials.ts` | Strips `user:pass@` from `http(s)` URLs                           |
| `exitCodes.ts`             | `EXIT_OK`, `EXIT_FAILED`, `EXIT_NONE_FIT`                         |
| `*.test.ts`                | One per file. `report.test.ts` also runs the redaction end to end |

## Depends on, used by

Depends on: `config/load` (`redactSecrets`, `LoadedConfig`).
Used by: `doctor.ts`, `checks/`, `envFile/`, `folders/` (results), `readiness/` (exit codes and
`withoutUrlCredentials`).

## Change it safely

- Run `pnpm vitest run src/cli/doctor/report`.
- Tests pin the exact text: symbols, indent, `fix:` and the summary wording.
- Do not move redaction into the checks. Do not print a value from `.env` or a secret.
