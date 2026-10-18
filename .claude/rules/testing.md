---
paths:
  - 'src/**'
  - 'test/**'
  - 'evals/**'
---

# Testing

- **TDD.** Write the failing test first, see it fail for the right reason, then implement.
- **Layout.** A test sits next to its code: `src/<feature>/<file>.test.ts`, variants as
  `<file>.<case>.test.ts`. Fixtures in the feature's `__fixtures__/<area>/`. `test/` holds only the
  shared kit, cross-feature `integration/` and `live/` tests, and `fixtures/config/`.
- **Shared kit.** Use `test/fakes` (`FakeModelProvider`, `FakeInputGuard`, `FakeOutputGuard`,
  `FakeSourceFetcher`, `MemoryRunStore`, `CapturingDelivery`, `fixedClock`, `noopLogger`) and
  `test/builders.ts`. Need another helper? Keep it inside your own test file.
- **No network in unit tests.** Adapters take an injected `fetch`; tests pass a fake that serves
  fixtures. Never call a real feed, Ollama, SMTP or Slack from `pnpm test`.
- **Live tests.** Only in `test/live/`, skipped unless `LIVE_OLLAMA=1`. They are lane `gpu`:
  one live session at a time on this machine.
- **Time.** Inject `Clock`; never call `new Date()` for "now" in code under test.
- **Coverage.** 80% or more on every `src` file an issue owns:
  `pnpm vitest run --coverage --coverage.include='src/sources/adapters/rss.ts'`.
- **Names.** Describe behavior: `it('skips a source that times out and lists it as failed')`.
