# Engineering Digest Agent

Local-first CLI agent: collects allowlisted RSS/Atom feeds and GitHub releases, then runs
guard-input → classify → process → write (writer panel) → guard-output → select → deliver,
all on Ollama. Output: a weekly Markdown digest of the 3-5 releases that matter, in `dist/`.
Full spec (private, main checkout only): `docs/plan/spec.md`.

## Map

The code is split into feature folders. Each one has its own `CLAUDE.md` (intent, design, how it
works), and its tests sit next to the code. Pipeline order:

| Folder                                                | What                                                                                                           |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `src/digest/`                                         | The weekly run: `runDigest` (lock → chain → finish), run ending, resume, the step loop                         |
| `src/sources/`                                        | `SourceFetcher` port, the collect step, default sources, `adapters/` (RSS, GitHub, fetch pipeline, `archive/`) |
| `src/guards/`                                         | `Guard` port, input and output guard steps, guard questions, `adapters/` (Granite, clef)                       |
| `src/classify/`                                       | Classify step and prompt: relevance, area, hype, minor release per item                                        |
| `src/process/`                                        | Filter by thresholds, cross-week dedupe, rank, top N                                                           |
| `src/write/`                                          | Writer panel step and prompt                                                                                   |
| `src/checks/`                                         | Link check and format check (always on)                                                                        |
| `src/select/`                                         | Judge step and prompt: picks the best passing draft                                                            |
| `src/render/`                                         | Digest view, Markdown, canonical scoring text, review sheet                                                    |
| `src/delivery/`                                       | `Delivery` port, `adapters/` (Markdown file, SMTP and email HTML, Slack blocks)                                |
| `src/models/`                                         | `ModelProvider` port, `generateStructured()`, `adapters/` (Ollama, decision endpoint)                          |
| `src/store/`                                          | `RunStore` port, `layout.ts` (the `dist/` layout), `adapters/` (run folders, lock with heartbeat and takeover) |
| `src/domain/`                                         | `schemas.ts`: the types several features share (zod); feature-owned types live in their feature                |
| `src/config/`                                         | `schema.ts` (zod), `profiles.ts` (role → model tag), `load.ts`                                                 |
| `src/app/`                                            | `container.ts`: the composition root (config → adapters → `DigestDeps`), plus decorators                       |
| `src/cli/`                                            | `program.ts` registers commands; one folder per command (`init/`, `doctor/`, `run/`, …)                        |
| `src/scheduler/`, `src/observability/`, `src/shared/` | Weekly scheduler; pino logs and OTel; small utilities (errors, retry, text, `atomicFile`)                      |
| `evals/`                                              | Eval data (recorded weeks, cases, scorecards) and the harness code with its tests                              |
| `test/`                                               | Shared test kit (`fakes/`, `builders.ts`), cross-feature `integration/` and `live/` tests                      |

## Commands

```bash
pnpm install
pnpm check                 # typecheck + lint + unit tests: must be green before any commit
pnpm test:watch
pnpm vitest run --coverage --coverage.include='src/path/file.ts'   # coverage of one file
pnpm digest run --dry-run  # tsx, no build needed
pnpm build                 # esbuild → dist/artifacts/cli.js
pnpm docs:mermaid          # parse every Mermaid block in tracked Markdown
```

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
- ESM, relative imports without extensions, named exports, no default exports, no barrels.
- Immutable data: return new objects; do not mutate inputs.

## Testing bar

- TDD: write the failing test first. Unit tests use `test/fakes` and inject `fetch`; no network.
- Live Ollama tests live in `test/live/` and run only with `LIVE_OLLAMA=1`.
- At least 80% coverage on every file you own.

## Git and parallel work

- Work is split into issues in `docs/plan/issues/` (gitignored, main checkout only).
  Workers run `/implement-issue <id>` in their own worktree; the coordinator runs `/merge-issue`.
- Read `.claude/rules/parallel-work.md` before editing anything on an issue branch.
- Commits: conventional (`feat: …`), subject ≤ 72 chars, signed, authored by the maintainer.
  Never add Co-Authored-By or "Generated with" lines. Never push; the maintainer pushes.
