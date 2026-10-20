# Parallel work in worktrees

Several agents may build this repo at once, each on one task in its own git worktree. This works
only if no two of them touch the same file.

## Ownership

- The coordinator's brief names the files you may create or change (plus their tests, fixtures
  and the feature's `CLAUDE.md`). Touch nothing else; `git diff --name-only main...HEAD` shows it.
- **Frozen files** (blocked by the `guard-frozen` hook on any branch but `main`): `package.json`,
  `pnpm-lock.yaml`, tool configs, `CLAUDE.md`, `.claude/**`, `.githooks/**`, `.github/**`,
  the five ports (`src/models/ModelProvider.ts`, `src/guards/Guard.ts`,
  `src/sources/SourceFetcher.ts`, `src/delivery/Delivery.ts`, `src/store/RunStore.ts`),
  `eslint-rules/**`, `knip.json`, `.jscpd.json`, `pnpm-workspace.yaml`,
  `src/domain/schemas.ts`, `src/models/structured.ts`, `src/config/schema.ts`,
  `src/config/profiles.ts`, `src/shared/**`, `src/cli/program.ts`, `src/cli/index.ts`,
  `test/fakes/**`, `test/builders.ts`.
- Need a frozen file changed, or a new dependency? Do not work around it. Stop and report the
  exact change; the coordinator makes it on `main`, then you `git rebase main` and continue.
- Do not change another module's exported signatures unless your brief says so.

## Git

- Branch from local `main`. Never switch to or commit on `main` inside a worktree.
- Before handing back: `git rebase main`, then squash to one commit: `git reset --soft main && git commit`.
- Commit as configured (Oleksandr Derechei, SSH-signed). Conventional subject ≤ 72 chars,
  e.g. `feat(sources): add RSS/Atom fetcher`. No Co-Authored-By or "Generated with" lines;
  the `commit-msg` hook rejects them, and also a subject over 72 characters.
- **Never push, never merge.** The coordinator merges locally with `git merge --ff-only`.

## Lanes

- `cpu`: unit tests with fakes. Any number in parallel.
- `gpu`: runs real Ollama models. One at a time on this machine (`OLLAMA_MAX_LOADED_MODELS=1`).
- `human`: needs the maintainer (labels, approvals, grading). Draft, then stop and ask.
- `research`: reading and writing docs or data, no code paths.
