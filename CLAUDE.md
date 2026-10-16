# Engineering Digest Agent

Local-first CLI agent: collects allowlisted RSS/Atom feeds and GitHub releases, then runs
guard-input → classify → process → write (writer panel) → guard-output → select → deliver,
all on Ollama. Output: a weekly Markdown digest of the 3-5 releases that matter.
Full spec (private, main checkout only): `docs/plan/spec.md`.

## Map

| Path                                   | What                                                                                                                         |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `src/core/`                            | `runDigest.ts`, `steps/`, `checks/`, `render.ts`, `structured.ts`, `schemas.ts`, `prompts/`. Knows no vendor, file or cloud. |
| `src/ports/`                           | The five interfaces: `ModelProvider`, `Guard`, `SourceFetcher`, `Delivery`, `RunStore`                                       |
| `src/adapters/`                        | Real implementations: `models/ollama`, `guard/`, `sources/`, `delivery/`, `store/`                                           |
| `src/config/`                          | `schema.ts` (zod), `profiles.ts` (role → model tag), `load.ts`, `defaultSources.ts`                                          |
| `src/shared/`                          | `retry`, `isoWeek`, `errors`, `clock`, `untrusted`, `telemetry` (Logger/Tracer interfaces)                                   |
| `src/app/container.ts`                 | Composition root: config → adapters → `DigestDeps`                                                                           |
| `src/cli/`                             | `program.ts` registers commands; one handler file per command                                                                |
| `src/scheduler/`, `src/observability/` | Weekly scheduler; pino logs and optional OTel                                                                                |
| `evals/`                               | Recorded weeks, labeled cases, metrics, scorecard                                                                            |
| `test/`                                | Vitest; `test/fakes/` and `test/builders.ts` are the shared test kit                                                         |

## Commands

```bash
pnpm install
pnpm check                 # typecheck + lint + unit tests: must be green before any commit
pnpm test:watch
pnpm vitest run --coverage --coverage.include='src/path/file.ts'   # coverage of one file
pnpm digest run --dry-run  # tsx, no build needed
pnpm build                 # esbuild → dist/cli.js
```

## Hard rules

- **Ports and adapters.** `src/core` and `src/ports` never import adapters, CLI, scheduler,
  observability, `config/load`, `node:fs`, `ollama` or `nodemailer`. ESLint enforces it.
- **Steps are plain async functions** `(input, deps) => output`; Mastra only wraps them in
  `core/workflow.ts`. Model calls go through `ModelProvider`, never `fetch` in core.
- **Every prompt that embeds collected text** uses `wrapUntrusted()` and `UNTRUSTED_DATA_RULE`.
- **Structured model output** goes through `generateStructured()` (zod schema, one repair).
- **Link check and format check are always on.** Config can never disable them.
- **Recipients and endpoints come from config/.env only**, never from model output.
- **Secrets never reach logs, run records or traces.** Never read `.env`.
- ESM with `.js` import suffixes, named exports, no default exports, no barrels in `src/`.
- Immutable data: return new objects; do not mutate inputs.

## Testing bar

- TDD: write the failing test first. Unit tests use `test/fakes` and inject `fetch`; no network.
- Live Ollama tests live in `test/live/` and run only with `LIVE_OLLAMA=1`.
- At least 80% coverage on every file you own. Fixtures go under `test/fixtures/<area>/`.

## Git and parallel work

- Work is split into issues in `docs/plan/issues/` (gitignored, main checkout only).
  Workers run `/implement-issue <id>` in their own worktree; the coordinator runs `/merge-issue`.
- Read `.claude/rules/parallel-work.md` before editing anything on an issue branch.
- Commits: conventional (`feat: …`), subject ≤ 72 chars, signed, authored by the maintainer.
  Never add Co-Authored-By or "Generated with" lines. Never push; the maintainer pushes.
