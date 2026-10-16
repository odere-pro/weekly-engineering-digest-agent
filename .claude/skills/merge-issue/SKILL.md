---
name: merge-issue
description: Coordinator protocol. Land issues in status "review" onto local main by rebasing in their worktree, gating, verifying the signature and fast-forwarding main. Use when asked to "merge W1-03", "merge ready issues", or "/merge-issue".
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

For each issue in `review` (the ids given, or all when "all" or empty), in dependency order:

1. Read its frontmatter: `branch`, `worktree`. Skip it (and say why) if a `depends_on` issue is
   not `done`.
2. Rebase onto current main **inside its worktree**, then gate there:
   ```bash
   git -C "<worktree>" rebase main
   (cd "<worktree>" && pnpm install --frozen-lockfile --prefer-offline && pnpm check)
   node "$PLAN/bin/check-owns.mjs" <ID> --repo "<worktree>"
   ```
3. Check the commit: exactly one commit ahead of main, signed and clean.
   ```bash
   test "$(git rev-list --count main..<branch>)" = 1
   git verify-commit <branch>
   git log -1 --format=%B <branch> | grep -Eiq 'co-authored-by|generated with' && echo "REJECT"
   ```
4. Fast-forward: `git merge --ff-only <branch>`.
5. Set the issue to `status: done` and add `merged: <short sha>` under its `## Notes`.
6. Clean up worktrees from `spawn.sh` (path under `.claude/worktrees/`):
   `git worktree remove "<worktree>" && git branch -d <branch>`.
   For a desktop-session worktree, leave it and offer to archive the session; do so only on yes.

On a rebase conflict, a red gate, a missing signature or out-of-scope files: do not merge. Run
`git -C "<worktree>" rebase --abort` if needed, set the issue to `status: blocked` with the exact
reason under `## Notes`, and continue with the next issue.

After the batch: `pnpm check` on main, then `node "$PLAN/bin/board.mjs"` and report what was
merged, what is blocked and what is now ready.
