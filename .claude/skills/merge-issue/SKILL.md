---
name: merge-issue
description: Coordinator protocol. Land issues in status "review" onto local main with cheap per-issue checks, a rebase only when main moved, a signature check and a fast-forward, then one full gate for the batch. Use when asked to "merge W1-03", "merge ready issues", or "/merge-issue".
argument-hint: '[issue ids… | all]'
---

# Merge issues: $ARGUMENTS

Run only in the main checkout, on `main`, with a clean working tree. The user chose local merges:
never push, never open PRs.

```bash
git branch --show-current   # main
git status --porcelain      # empty
PLAN="$PWD/docs/plan"
node "$PLAN/bin/board.mjs"  # issues in review, in dependency order
```

Take the issues in `review` (the ids given, or all when "all" or empty), in dependency order. Skip
one whose `depends_on` is not `done`, and say why. Then run the whole batch in one call:

```bash
bash "$PLAN/bin/merge-fast.sh" <ID> <ID> ...
```

Per issue, it does only the cheap steps. Each worker already ran `pnpm check` on its own branch:

1. The worktree must be clean, `check-owns` must pass, and the branch must be exactly one commit ahead of main with no AI trailer.
2. It rebases inside the worktree **only when main has moved**. The rebase re-signs the commit, which means one 1Password prompt.
3. `git verify-commit`, then `git merge --ff-only`.

Then it runs **one full gate on main** for the batch: typecheck, lint, format check and every
test, with `--maxWorkers=50%` (override with `GATE_WORKERS`) and a 30 s test timeout.

- **Green:** each issue is set to `done` with its sha.
- **Red:** the merged issues go back to `review`. Fix forward on main, find the cause from the failing
  tests (`git log` on their files), then re-run the gate.

A rebase conflict, a signing failure, a missing signature or out-of-scope files stop that issue only.
It is set to `blocked` with the reason, except a signing failure, which stays in `review`. The batch
continues with the next issue.

After the batch:

- Clean up worktrees from `spawn.sh`: `git worktree remove "<worktree>" && git branch -d <branch>`.
- Desktop-session worktrees go away when their session is archived. Archive only with the user's yes.
- Report what was merged, what is blocked and what is now ready (`node "$PLAN/bin/board.mjs"`).
