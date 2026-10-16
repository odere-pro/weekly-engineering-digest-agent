#!/usr/bin/env bash
# PostToolUse (advisory): format and lint-fix the edited file. Never blocks; `pnpm check` is the gate.
set -uo pipefail

input="$(cat)"
file="$(jq -r '.tool_input.file_path // empty' <<<"$input" 2>/dev/null)"
[ -n "$file" ] && [ -f "$file" ] || exit 0

case "$file" in
  */docs/plan/* | */node_modules/* | */dist/* | */coverage/*) exit 0 ;;
  *.ts | *.js | *.mjs | *.json | *.md | *.yml | *.yaml) ;;
  *) exit 0 ;;
esac

root="${CLAUDE_PROJECT_DIR:-$PWD}"
case "$file" in "$root"/*) ;; *) exit 0 ;; esac  # only files inside this checkout
cd "$root" 2>/dev/null || exit 0

[ -x node_modules/.bin/prettier ] && node_modules/.bin/prettier --write --log-level silent "$file" >/dev/null 2>&1
case "$file" in
  *.ts | *.js | *.mjs) [ -x node_modules/.bin/eslint ] && node_modules/.bin/eslint --fix "$file" >/dev/null 2>&1 ;;
esac
exit 0
