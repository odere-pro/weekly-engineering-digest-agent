---
name: static-analysis
description: Run, read and act on this repo's static analysis (type-aware ESLint with the regexp plugin and the local `digest/*` rules, knip, jscpd, zizmor, CodeQL, the property tests). Use before a commit, when `pnpm check`, `pnpm analyze` or `pnpm lint:actions` or a CI analysis job fails, when a CodeQL or zizmor alert arrives, or when asked whether the code is clean.
---

# Static analysis

Each tool below guards a bug class that a multi-agent review once found by hand. Run them before a
commit, read what they say, fix the code. A bug the tools could have caught but did not becomes a
new check: use the `add-lint-rule` skill.

## The tools

| Tool and what it guards                                                                                                      | Command                                         | Typical fix                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `regexp/no-super-linear-*` (ESLint): ReDoS. A link-check regex took 25 s on 64 KB of `](  `                                  | `pnpm lint`                                     | Start a run only where it starts: `(?<!x)x+$`. Split `\s*` / `[\s\S]*?` chains, or use string work (`fencedBody`). |
| `digest/fetch-redirect` (local rule): the Ollama client followed 307/308, so prompts could leave the allowlist (invariant 4) | `pnpm lint`                                     | State `redirect: 'manual'` or `'error'` in the init object at the call.                                            |
| knip: the `ollama` dependency nothing imported; dead exports and files                                                       | `pnpm knip` (in `check`)                        | Delete the dead code or drop its `export`. A dependency leaves `package.json` only with the maintainer.            |
| jscpd: `mapWithConcurrency`, `causeChain`, `parseSince` copied between features                                              | `pnpm dupes` (`pnpm analyze` = knip + dupes)    | Move the shared piece to `src/shared` or its owning feature. Never raise `threshold` in `.jscpd.json`.             |
| zizmor: actions pinned to mutable tags, checkout credentials persisted, wide permissions                                     | `pnpm lint:actions` (offline, needs uv); CI job | Pin to a full SHA with the tag in a comment, `persist-credentials: false`, per-job `permissions`.                  |
| CodeQL: polynomial ReDoS, incomplete URL sanitisation, request forgery, clear-text logging of secrets                        | CI only (`codeql.yml`)                          | Fix the code, see below.                                                                                           |
| Per-file coverage: `src/cli/program.ts` sat at 66% under a 99% average                                                       | `pnpm coverage`                                 | Add tests for the file named in the error; the bar is 80% on each file.                                            |
| Time zone leg in CI: five tests passed only in UTC                                                                           | `TZ=Pacific/Kiritimati pnpm vitest run`         | Build test instants from local parts (`new Date(y, m, d, h)`), never from a UTC string.                            |
| fast-check property test: render and link check disagreed on a collected URL (`it's-here`, `a)b`, `&amp;`)                   | `pnpm vitest run .property.test`                | See "A property fails". `FAST_CHECK_RUNS=20000` searches harder than the default 100.                              |
| `minimumReleaseAge` (`pnpm-workspace.yaml`): a malicious version published hours ago                                         | `pnpm install`                                  | Wait 14 days, or ask the maintainer to add `minimumReleaseAgeExclude`.                                             |

## Triage

- Fix first. A finding is a bug or a smell until shown otherwise; read the rule's message, it says why.
- A narrow suppression always carries a reason: `// eslint-disable-next-line <rule> -- <why>`,
  `# zizmor: ignore[<audit>] <why>`, a JSDoc `@public` tag (knip: exported on purpose). An unused
  disable fails lint, so remove it when the code changes.
- Never, without the maintainer: turn a rule off globally or for a folder, raise the jscpd threshold,
  lower a coverage threshold, widen a knip `ignore`, add a dependency.
- A security finding (CodeQL, `digest/fetch-redirect`, ReDoS) is fixed, not suppressed. Dismiss one
  only when a test proves it false, and say so in the dismissal.
- Rewriting a regex: keep it equivalent. Run the file's tests, and add a hostile-input test (a 100,000
  character run) that must finish in under a second.

## A property fails

fast-check prints `seed`, `path` and the shrunk counterexample. Replay with
`fc.assert(property, { seed, path })`. Fix the product code (`canonicalLink`, the renderer or the
check), never the property. Then add the counterexample as a plain example in the feature's test.

## CodeQL alerts

```bash
gh api "repos/{owner}/{repo}/code-scanning/alerts?state=open" --jq '.[] | [.number, .rule.id,
  .rule.security_severity_level, .most_recent_instance.location.path,
  .most_recent_instance.location.start_line] | @tsv'
```

Read the alert's `most_recent_instance.location` and `.message.text`, open that line, fix it, push.
For a pull request add `&ref=refs/pull/<n>/merge`. It cannot run locally: `.github/workflows/codeql.yml`
needs a push. Actions in it are pinned to a SHA; bump by the note in `ci.yml`.

## zizmor locally

`pnpm lint:actions` runs offline (no GitHub calls). The CI job also runs the online audits (impostor
commits, known-vulnerable actions); locally: `GH_TOKEN=$(gh auth token) uvx zizmor@1.30.1 .github/workflows`.
`--persona=auditor` adds info and low findings.

## What the tools do not catch

Semantic bugs: a threshold that is wrong, a prompt that misleads, a check that passes and misreads,
timing and ordering between runs, model behaviour. For those use a property test (round trips, "for
all inputs"), a test from the real case, and review. When review finds one a pattern could catch,
write the rule.
