---
name: implement-issue
description: Worker protocol. Implement one issue from docs/plan/issues in the current worktree, test-first, within its owned files, ending with one signed commit and status "review". Use when asked to "implement W1-03", "/implement-issue <id>", or to pick up a planned issue.
argument-hint: <issue id, e.g. W1-03>
---

# Implement issue $ARGUMENTS

You are a worker. You build exactly one issue, in this worktree, and stop at a reviewed commit.
Read `.claude/rules/parallel-work.md` first if you have not.

## 0. Locate

```bash
PLAN="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")/docs/plan"
ISSUE="$(ls "$PLAN"/issues/$ARGUMENTS-*.md)"
git branch --show-current     # must NOT be main
```

- If the branch is `main`, stop: workers never run on main. Ask the user to start a worktree.
- Read the issue file fully, then the spec sections it cites in `$PLAN/spec.md`.
- If its frontmatter says `runs_on: main`, stop: the coordinator runs it on main.

## 1. Preflight

- Run `node "$PLAN/bin/board.mjs" --check $ARGUMENTS`. If any `depends_on` issue is not `done`, stop
  and report which.
- In the issue frontmatter set `status: in_progress`, `branch: <current branch>`,
  `worktree: <pwd>`. Edit only this issue file in `$PLAN`.
- `git rebase main` and `pnpm install --frozen-lockfile --prefer-offline`.
- Lane `gpu`: confirm no other issue is `in_progress` in lane `gpu` (`board.mjs`), else stop.
- Lane `human`: draft what you can, then stop and ask the user for the human part.

## 2. Build test-first

1. Write the tests listed in the issue in the owned test files. Run them; they must fail for
   the right reason (often `NotImplementedError`).
2. Implement the smallest code that passes. Keep the stub's exported signatures exactly.
3. Refactor: small functions (< 50 lines), no mutation of inputs, explicit error handling,
   no `console.*` outside `src/cli`, no hardcoded thresholds (they come from config).
4. Repeat until every acceptance item in the issue is covered by a test.

If you need a change in a frozen file or a new dependency: set `status: blocked`, write the exact
change under `## Notes`, and stop. Never work around it.

## 3. Gate (all must pass)

```bash
pnpm check
pnpm vitest run --coverage --coverage.include='<each owned src file>'   # ≥ 80% lines/branches/functions
node "$PLAN/bin/check-owns.mjs" $ARGUMENTS                               # only owned files changed
```

Then launch a `typescript-reviewer` agent on `git diff main...HEAD` plus your uncommitted changes.
Fix every CRITICAL and HIGH finding, then re-run the gate.

## 4. Commit (one signed commit)

`main` may have moved while you worked, so rebase first and squash onto the merge base
(never `git reset --soft main` directly: it would revert whatever landed on main meanwhile).

```bash
git add -A && git commit -q -m "wip" || true      # park all work in a commit
git rebase main                                     # bring in the latest main
git reset --soft "$(git merge-base HEAD main)"      # squash everything since main
git commit -m "<type>(<area>): <what> ($ARGUMENTS)"
node "$PLAN/bin/check-owns.mjs" $ARGUMENTS          # still only owned files
git verify-commit HEAD                              # Good signature for odere.pro@gmail.com
```

- Subject ≤ 72 chars, imperative. Body only if the why is not obvious (≤ 10 lines).
- No Co-Authored-By, no "Generated with" line (the commit-msg hook rejects them).
- Never push. Never merge. Never touch `main`.

## 5. Hand off

In the issue frontmatter set `status: review`. Append to its `## Notes` section: a 2-4 line summary,
test count and coverage, and any follow-up or contract concern. Then reply with that summary and stop.
