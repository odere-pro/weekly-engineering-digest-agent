# Stages

> One function per step of the chain, each `(ctx, state, logger) => Promise<ChainState>`: it calls
> its feature's step with config and ports, saves the stage's file and says whether the run goes on.
> Entry: `chainSteps(ctx)`, the stages in order; a dry run has no `deliver`.

## Flow

```mermaid
flowchart LR
  collect --> guardInput --> classify --> process --> write --> guardOutput --> select --> deliver
  collect -.->|"no items: quiet"| settled(("settled"))
  process -.->|"under 3 items: quiet"| settled
  guardOutput -.->|"nothing passed, no fallback: blocked"| settled
```

| Stage         | Function       | Calls                       | Leaves in `ChainState`                         |
| ------------- | -------------- | --------------------------- | ---------------------------------------------- |
| `collect`     | `collect`      | `collectStep`               | `collected`, `failedSources`; items.json       |
| `guardInput`  | `guardInput`   | `guardInputStep`            | `kept`                                         |
| `classify`    | `classify`     | `classifyStep`              | `scored`; scores.json                          |
| `process`     | `processItems` | `processStep`               | `selected`, `afterProcess`                     |
| `write`       | `write`        | `writeCheckedStep`          | `checked`, `drafts`, `draftsFile`; drafts.json |
| `guardOutput` | `guardOutput`  | `guardOutputStep`, fallback | `drafts`, `passed`, maybe `fallback`           |
| `select`      | `selectWinner` | `selectStep` (2+ drafts)    | `winner`, scored `drafts`; digest.md           |
| `deliver`     | `deliver`      | `shipDigest`                | `deliveredTo`, `sentUrls`                      |

## Rules

- Run files go through `keepArtifact`: written at once, or held when `holdArtifacts` is on.
- `write` throws `PartialFailure` when every writer failed, naming writers, never model text.
  `guardOutput` falls back to `withFallback` when no draft passed; `blocked` names writers and checks.
- `deliver` tries every channel. A channel that took the digest counts its URLs as sent even when
  another failed; the `PartialFailure` keeps them for the rerun.

## Files

| File                        | Role                                                                     |
| --------------------------- | ------------------------------------------------------------------------ |
| `chainSteps.ts`             | `chainSteps`: wraps each stage with `stage` from `chain/`                |
| `keepArtifact.ts`           | `keepArtifact`: write a run file now, or hold it                         |
| `collect.ts` … `deliver.ts` | The eight stages above                                                   |
| `draftOutcomes.ts`          | `rejected`, `inWriterOrder`, `blocked`: the draft outcomes of the record |
| `withFallback.ts`           | `withFallback`: the template-only digest as the one passing draft        |
