# Running parts of the eval

Part of [Evaluation](README.md).

A full `digest eval` takes 45 to 110 minutes of model time. Three options added in wave 11 (W11-08)
make a cheap question cheap and keep a long run from being lost: `--only <section>`, `--resume` and
`--compare <files...>`. The code is in `src/cli/eval/`, `evals/checkpoint*.ts` and `evals/compare.ts`.

## Run one section: `--only`

```bash
pnpm digest eval --profile light --only guards
```

A section runs only its own part of the eval and leaves the other metrics unmeasured.

| Section    | Runs                                                                 | Metrics measured                                                                                                                                                       |
| ---------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `guards`   | The attack replay (plus a plain replay of the first week), grounding | attack handling, guard attack recall, groundedness, guard false blocks                                                                                                 |
| `classify` | The classifier cases                                                 | classifier accuracy                                                                                                                                                    |
| `sources`  | The source recordings, with no model                                 | source parse yield, source summary fill                                                                                                                                |
| `weeks`    | The recorded weeks, three replays each, and the judge                | link validity, format, guard blocks on real weeks, must-include recall, must-exclude leaks, writing quality, selection agreement, writer win rate, stability, run time |

- Any other name stops with `Unknown section "x". Use guards, classify, sources, weeks.`
- In a `guards` run, guard false blocks has only the output-guard controls. The input guards' clean
  items come from the week replays, which that run does not make.
- The maintainers' notes in `evals/README.md` put `guards` and `classify` at under 5 minutes each.

### Partial scorecards

A partial run prints `Partial run: guards. Other metrics are not run; gates are reported, not
enforced.` and saves `evals/scorecards/<date>-<profile>-partial-<section>.json` with
`partial: ["guards"]`. Metrics outside the section have no value and the note
`not run (--only guards)`. The gates of the section are shown, but **a partial run never fails the
command**: it exits 0. A partial scorecard is for a quick check, not a baseline. It never replaces
the full scorecard of the same day.

## Finish a lost run: `--resume`

```bash
pnpm digest eval --profile light --resume
```

Every week replay is saved when it ends, under `<dataDir>/eval/checkpoints/<date>/` (`dataDir` is
`data` by default), as `<profile>.<week>.run<n>.json`. That covers all three replays of each week
and the first-week replay a `guards` run needs. Files are written on every run. They are read only
with `--resume`.

- `--resume` uses the newest date folder, so a run lost yesterday can be finished today.
- A saved file counts as missing, and the replay runs again, when its fingerprint differs. The
  fingerprint is the git commit plus a hash of uncommitted changes, the profile, the whole config
  and the model of each role. Editing a prompt, changing the config or committing starts over.
  Outside a git checkout no file is ever reused.
- A half-written or unreadable file also runs again. A failed save is a warning, not an error.
- Not saved, so they run again: the attack replay, the classifier cases, the grounding drafts,
  the source recordings and the judge scoring.

## Compare two scorecards: `--compare`

```bash
pnpm digest eval --compare evals/scorecards/2026-10-17-light.json evals/scorecards/2026-10-18-light.json
```

It runs nothing, reads no config and needs no Ollama. It prints the two files, the profile and
date of each, a note when either is partial, and a table of all 17 metrics:

| Column          | Meaning                                                               |
| --------------- | --------------------------------------------------------------------- |
| `A`, `B`        | The value in each file; `n/a` when a file has none                    |
| `Delta`         | B minus A: percentage points for ratios, seconds for time, else plain |
| `Gate (B)`      | The gate as the second file saw it                                    |
| `Result A -> B` | `PASS`, `FAIL` or `-` for each, and the change when it moved          |

```text
Metric           A        B        Delta     Gate (B)     Result A -> B
Format           66.7%    83.3%    +16.7 pt  hard ≥ 100%  FAIL
Stability        0.00     1.67     +1.67     soft ≥ 4     FAIL
Run time         316.5 s  340.2 s  +23.6 s   reported     -
```

Under it comes `Weeks that changed status` (metric, week, before, after) for the `byWeek` rows whose
status differs, or `Weeks: no week changed status.` An old scorecard has `n/a` for metrics it
did not record. Errors: it needs exactly two files, a file that cannot be read or is not a scorecard
stops it with a message that names the file.

More: [how evals work](how-evals-work.md), [run the evals](../runbooks/run/run-evals.md).
