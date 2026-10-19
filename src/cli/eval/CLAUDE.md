# Eval command

> `digest eval`: replays the eval set per profile, prints each scorecard, saves it and returns the
> exit code. Entry: `evalCommand(options, io?) → ExitCode` (`eval.ts`). No port: the harness is
> `evals/runEval.ts`, and every outside touch goes through `EvalCommandIo`.

## Context

```mermaid
flowchart LR
  argv["program.ts"] -->|"EvalCommandOptions"| eval:::focus
  cfg[("digest.config.json, .env")] -.->|"loadConfig"| eval
  eval -->|"EvalOptions, EvalDeps"| harness["evals/runEval"]
  harness -->|"SavedScorecard"| eval
  eval -.->|"buildApp, once per profile"| app["app/container"]
  eval -.->|"the judge: createProvider"| mp[[ModelProvider]] -.-> ollama[(Ollama)]
  eval -->|"printed scorecard, exit code"| term[("terminal")]
  eval -->|"scorecards/*.json"| disk[("evals/scorecards")]
  classDef focus stroke-width:3px
```

## Flow

```mermaid
flowchart TD
  start["evalCommand: defaultIo with overrides"] --> cmp{"--compare?"}
  cmp -->|yes| pc["compare/: printComparison"] --> ok0["exit 0"]
  cmp -->|no| args["requestedSection, requestedProfiles: a bad name is a DigestError"]
  args --> cfgs["loadConfig, platformOf"] --> judge["judgeSetup/: prepareEvalJudge"]
  judge --> ck["checkpointDir, gitSha"] --> run["per profile: runEval"]
  run --> show["scorecardText/: formatScorecard, io.stdout"] --> save["saveScorecard"]
  save -->|"next profile"| run
  save --> gate{"every card partial or hard gates pass?"}
  gate -->|yes| ok1["exit 0"]
  gate -->|no| bad["exit 1"]
```

- A `DigestError` goes to stderr and returns its own exit code; any other error is rethrown.
- The scorecard file is `<casesDir>/scorecards/<day>-<profile>.json`, or
  `<day>-<profile>-partial-<section>.json` for `--only`, so a partial never replaces a full one.

## Rules

- Print first, then save: a failed save must not lose the result of a long run.
- Every profile builds the app from the loaded config with the platform the loader resolved
  (`platformOf`), not one recomputed from `process`: a container on a Mac must match its profile.
- Arguments are checked before `loadConfig` and before any model call; `--compare` needs no config.
- A hard gate that fails exits 1, but the other profiles of `--profile all` still run. A partial
  run reports its gates and never fails: the other sections were not run.
- One judge, built once, serves all profiles; its installed check runs before the first replay.
- The file is written through `SavedScorecardSchema.parse`: a card that does not match the schema
  throws instead of landing on disk.

## Files

| File / folder    | Role                                                                                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `eval.ts`        | `evalCommand`, `EvalCommandOptions`, `EvalCommandIo`, `defaultIo`, `currentGitSha`, profile and section parsing, `runProfiles`, `saveScorecard` |
| `scorecardText/` | The printed scorecard and the table cells. See `scorecardText/CLAUDE.md`                                                                        |
| `compare/`       | `--compare`: read two cards and print the table. See `compare/CLAUDE.md`                                                                        |
| `judgeSetup/`    | The judge from the `EVAL_JUDGE` variable. See `judgeSetup/CLAUDE.md`                                                                            |
| `__fixtures__/`  | `scorecardKit.ts`: `makeScorecard`, a card whose metrics all pass                                                                               |

`eval.test.ts` covers profiles, saving, exit codes, platform and judge wiring; `eval.fast.test.ts`
`--only`, `--resume` and `--compare`; `eval.defaultIo.test.ts` the real disk, stdout, stderr and git.

## Gotchas

- This folder imports `evals/`: `runEval`, `metrics`, `schema`, `checkpoint`, `checkpointSections`,
  `compare` and `judge/evalJudge`. Renaming one of those exports breaks the command. Nothing in
  `evals/` imports `src/cli`.
- A new option reaches argv only when the frozen `program.ts` registers it (the coordinator);
  `program.test.ts` pins the flags.
- `currentGitSha` runs `git` in the working directory. A dirty tree adds a hash of the diff, so
  editing a prompt makes `--resume` start over; outside a checkout the value is new every time.
- `EVAL_JUDGE` is two things (the environment variable and a model-tag constant): see
  `judgeSetup/CLAUDE.md`.
