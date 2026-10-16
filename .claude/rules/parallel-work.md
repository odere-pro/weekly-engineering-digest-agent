# Parallel work in worktrees

Many agents build this repo at once, each on one issue in its own git worktree. This works only
if no two of them touch the same file.

## Where things live

- Issues: `docs/plan/issues/<ID>-<slug>.md` in the **main checkout** (gitignored, so it is not in
  your worktree). Find it from anywhere:
  `PLAN="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")/docs/plan"`.
- The spec: `$PLAN/spec.md`. The board: `node "$PLAN/bin/board.mjs"`.

## Ownership

- Your issue's `owns:` globs are the only files you may create or change (plus its tests and
  fixtures, which are listed there too). `node "$PLAN/bin/check-owns.mjs" <ID>` verifies it.
- **Frozen files** (blocked by the `guard-frozen` hook on any branch but `main`): `package.json`,
  `pnpm-lock.yaml`, tool configs, `CLAUDE.md`, `.claude/**`, `.githooks/**`, `.github/**`,
  `src/ports/**`, `src/core/schemas.ts`, `src/core/structured.ts`, `src/config/schema.ts`,
  `src/config/profiles.ts`, `src/shared/**`, `src/cli/program.ts`, `src/cli/index.ts`,
  `test/fakes/**`, `test/builders.ts`.
- Need a frozen file changed, or a new dependency? Do not work around it. Set your issue to
  `status: blocked`, write the exact change in `notes`, and stop. The coordinator changes it on
  `main`; you then `git rebase main` and continue.
- Do not change another module's exported signatures. Stubs already have their final signatures.

## Issue lifecycle (frontmatter `status`)

`todo` → `in_progress` (worker started) → `review` (one signed commit, gate green) →
`done` (coordinator fast-forwarded `main`). `blocked` at any point, with the reason in `notes`.
Workers edit only their own issue file. Only the coordinator sets `done`.

## Git

- Branch from local `main`. Never switch to or commit on `main` inside a worktree.
- Before review: `git rebase main`, then squash to one commit: `git reset --soft main && git commit`.
- Commit as configured (Oleksandr Derechei, SSH-signed). Conventional subject ≤ 72 chars,
  e.g. `feat(sources): add RSS/Atom fetcher (W1-01)`. No Co-Authored-By or "Generated with" lines;
  the `commit-msg` hook rejects them.
- **Never push, never merge.** The coordinator merges locally with `git merge --ff-only`.

## Lanes

- `cpu`: unit tests with fakes. Any number in parallel.
- `gpu`: runs real Ollama models. One at a time on this machine (`OLLAMA_MAX_LOADED_MODELS=1`).
- `human`: needs the maintainer (labels, approvals, grading). Draft, then stop and ask.
- `research`: reading and writing docs or data, no code paths.
