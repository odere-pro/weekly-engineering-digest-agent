---
paths:
  - 'src/**'
  - 'test/**'
  - 'evals/**'
---

# Testing

- **TDD.** Write the failing test first, see it fail for the right reason, then implement.
- **Layout.** `test/<same path as src>/<file>.test.ts`. Fixtures in `test/fixtures/<area>/`.
- **Shared kit.** Use `test/fakes` (`FakeModelProvider`, `FakeInputGuard`, `FakeOutputGuard`,
  `FakeSourceFetcher`, `MemoryRunStore`, `CapturingDelivery`, `fixedClock`, `noopLogger`) and
  `test/builders.ts`. Need another helper? Keep it inside your own test file.
- **No network in unit tests.** Adapters take an injected `fetch`; tests pass a fake that serves
  fixtures. Never call a real feed, Ollama, SMTP or Slack from `pnpm test`.
- **Live tests.** Only in `test/live/`, skipped unless `LIVE_OLLAMA=1`. They are lane `gpu`:
  one live session at a time on this machine.
- **Time.** Inject `Clock`; never call `new Date()` for "now" in code under test.
- **Coverage.** 80% or more on every `src` file an issue owns:
  `pnpm vitest run --coverage --coverage.include='src/adapters/sources/rss.ts'`.
- **Names.** Describe behavior: `it('skips a source that times out and lists it as failed')`.
