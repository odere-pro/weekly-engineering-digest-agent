# Status and limits

Part of [Overview](README.md).

This is v0.1.0 plus fixes (see [`CHANGELOG.md`](../../CHANGELOG.md)). It is not published to npm:
install from a clone.

## What is measured

Only the `light` profile has a measured baseline, from 2026-10-18. The numbers, row by row, are
on the [results page](../evaluation/results.md).

- Three of the four hard quality gates pass: link validity, attack handling and groundedness are
  all at 100%.
- One hard gate is red: **format is at 83%**, because one recorded week (2026-W36) produced no
  digest in its first replay (earlier notes say the output guard blocked the draft; the scorecard
  records only `no-digest`).
- Several soft gates are red too (classifier accuracy, must-include recall, stability). The
  results page explains each one.
- `quality` and `fast` have no baseline.

## What to expect

- The guards can block good drafts. A blocked week sends a failure note, not a digest.
  See [blocked run](../runbooks/debug/blocked-run.md).
- Feeds are an allowlist of 24 default sources ([list](../sources.md)). GitHub keeps only the
  latest 10 releases per repository, so a busy week can lose some.
- One machine, one run at a time. There is no multi-user setup.
- The cloud is a proposal only: [cloud proposal](../operations/cloud-proposal.md).

The full list of known limits, with causes, is on [known limits](../operations/known-limits.md).

## Scope

| In scope                                     | Out of scope                 |
| -------------------------------------------- | ---------------------------- |
| One weekly digest from an allowlist of feeds | Arbitrary web crawling       |
| Local Ollama models                          | Hosted model APIs            |
| Markdown, HTML, email and Slack delivery     | A web UI or a database       |
| Offline evals with recorded data             | Live monitoring of the feeds |

## Related

- [Evaluation](../evaluation/README.md), [gates](../evaluation/gates.md)
- [Triage](../operations/triage.md) when a run does not end `sent`
