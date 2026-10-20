# Eval scorecard: guard and classifier metrics

`pnpm digest eval` replays the recorded weeks and writes a scorecard. `evals/CLAUDE.md` explains
the harness. This page explains the metrics that waves 11 and 12 added or changed. In the CLI output,
`detail` is numbers only and `byWeek` has one line per replay.

## Faster evals

A full run replays six weeks three times each and takes 45 to 110 minutes of GPU. Three options
make the cheap questions cheap and keep a long run from being lost.

```bash
# One section only (guards, classify, sources or weeks). Guards and classify take under 5 minutes.
pnpm digest eval --profile light --only guards

# Finish a run that was lost (for example when Ollama dropped half way).
pnpm digest eval --profile light --resume

# Compare two saved scorecards: every metric, both values, the delta and the gate.
pnpm digest eval --compare evals/scorecards/2026-10-17-light.json evals/scorecards/2026-10-18-light.json
```

- `--only` saves `<date>-<profile>-partial-<section>.json` with `partial: ["guards"]`. The other
  metrics are `n/a`. The gates of the section are shown, but a partial run never fails the command.
- Every week replay and stability run is saved under `<dataDir>/eval/checkpoints/<date>/`. `--resume`
  uses the newest date folder and skips what is saved there. A change in the config, the profile
  models or the git commit makes the saved files count as missing, so they run again.
- `--compare` prints the metric table, then the `byWeek` rows whose status changed between the
  two files. It runs nothing and needs no Ollama.

## Guard blocks on real weeks (`guardRealBlocks`)

What: the share of week replays where an output guard rejected every draft, so the week got no
digest. The three stability runs of each week count too (18 replays for 6 weeks).
Why: `guardFalseBlocks` only sees the synthetic clean controls (one per grounding case). In wave 6 it showed 1.7% while 2 of
18 real replays were blocked by the output guard. This metric asks the same question on the real
drafts.
How: the harness wraps the output guards in each replay and keeps every verdict with its reason. A
replay counts when its run ended `blocked` and a guard is among the rejecters of every draft. A run
rejected only by the link check or the format check is not a guard block. `detail` has `runs`,
`blockedRuns` and, per output guard, the share of replays it took part in blocking. `byWeek` names
the guard and the reason (cut to 200 characters) for each blocked replay.
Gate: soft, at most 5%.

## Fact carry (`factCarry`)

What: the share of shipped digest items whose versions, CVE and GHSA ids and ISO dates are all in
the item they came from. The item title, summary and action are each checked.
Why: the link and format checks look at form, and the groundedness guard is measured on planted
drafts only and never reads the title. Nothing compared the text a reader gets with its source.
How: `factCarry` in `metrics/digest/factCarry.ts` reads each week digest back with
`parseDigestMarkdown`, matches every item to its source by URL and looks up its facts
(`factTokensOf`, `src/write/provenance/factTokens.ts`) in the source title and summary. An item
with a link nobody collected, and a week with no digest, are left out and named in the note. Each
miss is a `byWeek` line with the part, the fact and the layers that let it through (the link and
format checks and every output guard that was on). The judge's mean accuracy rating is reported
next to writing quality (`detail.meanAccuracy`), never gated.
Gate: soft, at least 1. Scorecards written before it read `factCarry` as not recorded.

## Guard attack recall (`guardAttackRecall`)

What: the share of attack items that at least one input guard flags, and per guard how many it
flags on its own.
Why: in guard mode `any` a later guard never sees an item an earlier guard flagged, so its count
was only what it added. Granite showed 0 because of the order, not because it missed the attacks.
How: after the attack replay, the harness asks every enabled input guard about every attack item,
whatever the mode. A verdict the replay already got is reused. This is record only: the run's own
blocking, and `attackHandling`, stay as configured. The guards run one after the other, so one
model is loaded at a time. The extra calls cost about (guards - 1) times the number of attacks.
Gate: soft, at least 0.9 (unchanged).

## Why a week has no digest

What: in `format` and `stability`, a `byWeek` entry with status `no-digest` now names the cause:
`blocked by <guard>`, `rejected by <check>`, or `run ended as "<status>"` for other endings.
Why: before, a week with no digest looked the same whether a guard, the link check or a failed run
caused it.
How: read from the replay's run record (the rejecting ids of each draft). A stability entry lists
the cause of each empty run.
Gate: none; this only explains.

## Classifier accuracy (`classifierAccuracy`)

What: three numbers over the 60 labeled cases. `value` and the gate are the share with a relevance
within one point of the label (`relevanceWithinOne`). `detail` also has `area` (the share with the
right area) and `spearman` (rank correlation of predicted and labeled relevance; left out when it
is undefined).
Why: exact match on area and relevance within half a point punished small slips that do not change
what reaches the top 5. What matters is that the classifier ranks items in the right order and
puts them in about the right place.
How: `classifierRanking` in `metrics/ranking/classifier.ts`. Ties get the mean of their ranks. The
old measure stays as `classifierAccuracy` in the same file for the threshold sweep and the rescore
replay, which compare runs of their own.
Gate: soft, at least 0.8 on the within-one share. Scorecards written before this change keep their
old `detail` keys and still parse.
