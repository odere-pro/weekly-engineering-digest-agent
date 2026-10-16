---
name: plan-board
description: Show the build plan board from docs/plan (ready, in progress, review, blocked, needs-you) and propose the next batch of worker sessions. Use when asked "what's next", "show the board", "what can run in parallel", or "/plan-board".
argument-hint: '[launch]'
---

# Plan board

```bash
node "$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")/docs/plan/bin/board.mjs"
```

Report briefly:

- **Needs you:** `human` lane issues that are ready, and anything `blocked` (with its reason).
- **Review:** issues waiting for `/merge-issue`.
- **Ready now:** in priority order (batch, then id), respecting lanes: any number of `cpu` and
  `research`, at most one `gpu` (and none if a `gpu` issue is already in progress).
- **Critical path:** the next issues that unblock the most others.

Propose a batch of up to 6 ready issues. Then give both launch options:

1. **CLI:** `docs/plan/bin/spawn.sh <ids…>` creates one worktree per issue on `issue/<id>` and
   prints the `claude` command to run in each.
2. **Desktop:** offer to start one worktree session per issue with the brief
   `/implement-issue <id>` and the issue's `model`. Start them only after the user says yes
   (or when invoked as `/plan-board launch`).
