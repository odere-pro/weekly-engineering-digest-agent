# Init schedule

> The text that tells the user how to run the digest every week. It wraps `renderOsSchedule`
> (`scheduler/`). Entry: `scheduleSection(io, configPath, cron)` (`schedule.ts`).

## Flow

```mermaid
flowchart TD
  section["scheduleSection"] --> warn{"program is node plus a script that is not on disk?"}
  warn -->|yes| note["Warning: run pnpm build first, above the snippet"] --> cmd
  warn -->|no| cmd["scheduleCommand: program, -c config if not default, run"]
  cmd --> render["io.renderSchedule(platform, cron, command, workingDir)"]
  render -->|ok| text["save-as path, content, install hint"]
  render -->|throws| hint["No OS schedule snippet is available (reason)"]
```

## Rules

- A renderer failure never fails init: the reason is printed with the two ways to schedule by hand
  (`digest run` from a scheduler, or `digest serve`), and the exit code stays 0. The files are
  already written by then.
- The scheduled command works from any folder and names an absolute program: `defaultScheduleProgram`
  is this node binary plus the absolute script. A TypeScript entry (a dev run through tsx) cannot be
  started by plain node, so it runs the built CLI of the same repo (`<root>/dist/artifacts/cli.js`,
  the `package.json` `bin`; the root is two folders above `src/cli/index.ts`). launchd and systemd do
  not search PATH, so a bare `digest` is never emitted: `renderOsSchedule` refuses it on macOS and Linux.
- A built CLI that is not there yet still gets a snippet, with a warning line above it: run
  `pnpm build` first. `scheduleSection` takes the disk check as a fourth argument (default
  `existsSync`) and only looks at a `<node> <script>` program, so tests pass a fake.
- A config other than `./digest.config.json` is passed as `-c <absolute path>`; paths with
  whitespace are quoted.

## Files

| File          | Role                                                                            |
| ------------- | ------------------------------------------------------------------------------- |
| `schedule.ts` | `scheduleSection`, `scheduleCommand`, `defaultScheduleProgram`, `quoteIfSpaced` |
| `*.test.ts`   | Fake renderer and fake disk check; `process.argv` is replaced and restored      |

## Gotchas

- Not called in Docker: `init.ts` prints the Docker next steps instead (`summary/`).
- `createDefaultIo` (`io/`) fills `scheduleProgram` and `renderSchedule` from here and `scheduler/`.
