# Engineering Digest Agent

Local-first CLI agent: collects allowlisted RSS/Atom feeds and GitHub releases, then runs
guard-input (rule guard) → classify → process → guard-candidates (model guards) → write (writer
panel) → guard-output → select → deliver,
all on Ollama. Output: a weekly Markdown digest of the 3-5 releases that matter, in `dist/`.
The full spec is private and kept by the maintainer outside the repo.

## Map

The code is split into feature folders. Each one has its own `CLAUDE.md` (intent, design, how it
works), and its tests sit next to the code. Pipeline order:

| Folder                                                | What                                                                                                           |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `src/digest/`                                         | The weekly run: `runDigest` (lock → chain → finish), run ending, resume, the step loop                         |
| `src/sources/`                                        | `SourceFetcher` port, the collect step, default sources, `adapters/` (RSS, GitHub, fetch pipeline, `archive/`) |
| `src/guards/`                                         | `InputGuard`, `OutputGuard` ports, guard steps and questions, `adapters/` (rule, Granite, clef)                |
| `src/classify/`                                       | Classify step and prompt: relevance, area, hype, minor release per item                                        |
| `src/process/`                                        | Filter by thresholds, cross-week dedupe, rank, top N                                                           |
| `src/write/`                                          | Writer panel step and prompt                                                                                   |
| `src/checks/`                                         | Link check and format check (always on)                                                                        |
| `src/select/`                                         | Judge step and prompt: picks the best passing draft                                                            |
| `src/render/`                                         | Digest view, Markdown, canonical scoring text, review sheet                                                    |
| `src/delivery/`                                       | `Delivery` port, `adapters/` (Markdown file, SMTP and email HTML, Slack blocks)                                |
| `src/models/`                                         | `ModelProvider` port, `generateStructured()`, `adapters/` (Ollama: chat and decisions)                         |
| `src/store/`                                          | `RunStore` port, `layout.ts` (the `dist/` layout), `adapters/` (run folders, lock with heartbeat and takeover) |
| `src/domain/`                                         | `schemas.ts`: the types several features share (zod); feature-owned types live in their feature                |
| `src/config/`                                         | `schema.ts` (zod), `profiles.ts` (role → model tag), `load.ts`                                                 |
| `src/app/`                                            | `container.ts`: the composition root (config → adapters → `DigestDeps`), plus decorators                       |
| `src/cli/`                                            | `program.ts` registers commands; one folder per command (`init/`, `doctor/`, `run/`, …)                        |
| `src/scheduler/`, `src/observability/`, `src/shared/` | Weekly scheduler; pino logs and OTel; small utilities (errors, retry, text, `atomicFile`)                      |
| `evals/`                                              | Eval data (recorded weeks, cases, scorecards) and the harness code with its tests                              |
| `eslint-rules/`                                       | The local ESLint plugin `digest/*`: this project's own lint rules, with `RuleTester` tests                     |
| `test/`                                               | Shared test kit (`fakes/`, `builders.ts`), cross-feature `integration/` and `live/` tests                      |

## Commands

```bash
pnpm install
pnpm check                 # typecheck, lint, knip, format check, tests, Mermaid check, build: green before any commit
pnpm test:watch
pnpm coverage              # 80% lines, functions, branches and statements on every file, not on average
pnpm vitest run --coverage --coverage.include='src/path/file.ts'   # coverage of one file
pnpm knip                  # unused dependencies, files and exports (also part of check)
pnpm dupes                 # copy-paste growth (jscpd); `pnpm analyze` = knip + dupes
pnpm lint:actions          # zizmor audit of .github/workflows (needs uv); CodeQL runs in CI only
pnpm digest run --dry-run  # tsx, no build needed
pnpm build                 # esbuild → dist/artifacts/cli.js
pnpm docs:mermaid          # parse every Mermaid block in tracked and new (not ignored) Markdown
```

CI runs the same checks plus `pnpm coverage`, `pnpm dupes`, `pnpm audit --prod --audit-level high`,
a zizmor job and CodeQL.

## Hard rules

- **Ports and adapters.** A port is an interface the pipeline owns; an adapter plugs a real system
  into it. Pipeline features never import `**/adapters/**`, CLI, scheduler, observability, `app`,
  `config/load`, `node:fs`, `ollama` or `nodemailer`. ESLint enforces it. See
  `.claude/rules/architecture.md`.
- **Feature folders.** New code goes in the feature it belongs to, with its test next to it and
  fixtures in its `__fixtures__/`. Keep files under 300 lines; extract a subfeature folder instead.
  Update the feature's `CLAUDE.md` when its intent or design changes.
- **Steps are plain async functions** `(input, deps) => output`; a plain loop in
  `src/digest/workflow.ts` runs them. No workflow framework (ADR 0001 removed Mastra). Model calls go through `ModelProvider`, never `fetch` in the pipeline.
- **Every prompt that embeds collected text** uses `wrapUntrusted()` and `UNTRUSTED_DATA_RULE`.
- **Structured model output** goes through `generateStructured()` (zod schema, one repair).
- **Link check and format check are always on.** Config can never disable them.
- **Recipients and endpoints come from config/.env only**, never from model output.
- **Secrets never reach logs, run records or traces.** Never read `.env`.
- **Everything the project produces goes under `dist/`** (`config.dataDir`), laid out by
  `src/store/layout.ts`: build output in `dist/artifacts/`, a week's run in `dist/<monday>/digest/`,
  each source's fetched data in `dist/<day>/<sourceId>/raw/` and `formatted/`, logs in
  `dist/logs/<day>/`. Never write anywhere else; tests get a temp data folder from `makeConfig`.
- **Static analysis is part of done.** `pnpm check` runs type-aware ESLint (regexp ReDoS rules and
  the `digest/*` rules) and knip. A suppression carries `-- reason`; no rule, threshold or ignore is
  loosened without the maintainer. Skills: `static-analysis` (run and triage the tools),
  `add-lint-rule` (turn a bug found in review into a check).
- ESM, relative imports without extensions, named exports, no default exports, no barrels.
- Immutable data: return new objects; do not mutate inputs.

## Testing bar

- TDD: write the failing test first. Unit tests use `test/fakes` and inject `fetch`; no network.
- Live Ollama tests live in `test/live/` and run only with `LIVE_OLLAMA=1`.
- At least 80% coverage on every file you own.

## Git and parallel work

- Parallel work runs in worktrees, one task and one set of files per worker; the coordinator
  merges locally with `git merge --ff-only`. Read `.claude/rules/parallel-work.md` before editing
  anything on a worktree branch.
- Commits: conventional (`feat: …`), subject ≤ 72 chars, signed, authored by the maintainer.
  Never add Co-Authored-By or "Generated with" lines. Never push; the maintainer pushes.
- The `commit-msg` hook in `.githooks/` is active only where `core.hooksPath` points at it;
  `make install` sets that.
