#!/usr/bin/env bash
# PreToolUse: on any branch except main, block edits to frozen contract files.
# Workers that need a contract change set their issue to blocked; the coordinator edits on main.
# See .claude/rules/parallel-work.md.
set -uo pipefail

input="$(cat)"
file="$(jq -r '.tool_input.file_path // empty' <<<"$input" 2>/dev/null)"
[ -z "$file" ] && exit 0

root="${CLAUDE_PROJECT_DIR:-$PWD}"
branch="$(git -C "$root" branch --show-current 2>/dev/null)"
[ -z "$branch" ] || [ "$branch" = "main" ] && exit 0

rel="${file#"$root"/}"
case "$rel" in
  package.json | pnpm-lock.yaml | pnpm-workspace.yaml | tsconfig.json | eslint.config.js | \
  vitest.config.ts | .prettierrc.json | .prettierignore | .editorconfig | .gitignore | Makefile | \
  CLAUDE.md | .githooks/* | .claude/* | .github/* | \
  src/ports/* | src/core/schemas.ts | src/core/structured.ts | src/config/schema.ts | \
  src/config/profiles.ts | src/shared/* | src/cli/program.ts | src/cli/index.ts | \
  test/fakes/* | test/builders.ts)
    echo "Blocked: '$rel' is a frozen contract file (branch '$branch')." >&2
    echo "Do not edit it on an issue branch. Set your issue to status: blocked and write the exact" >&2
    echo "change you need in its notes; the coordinator changes it on main and you rebase." >&2
    exit 2
    ;;
esac
exit 0
