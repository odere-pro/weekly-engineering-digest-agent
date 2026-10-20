# Local ESLint rules (`digest/*`)

This project's own lint rules, as the plugin `digest` (`index.mjs`, registered in
`eslint.config.js`). Plain ESM with JSDoc types and `// @ts-check`; no dependency beyond ESLint.
A rule turns a bug the review found into a check that fails `pnpm lint` before the next review.

## Rules

| Rule                    | Guards                                                                                                                                                                                                                   | Scope                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| `digest/fetch-redirect` | Every call to the global `fetch` (or anything typed as it, such as an injected `fetchFn: typeof fetch`) states `redirect` in its init. The default follows a 307/308 to a host nobody configured (security invariant 4). | `src/**/*.ts`, `evals/**/*.ts`, not tests |

`fetch-redirect` is type-aware: it asks the type checker whether the callee's call signature is
declared by a function named `fetch` in a `.d.ts` file. The `SourceFetcher` port has a method
`fetch(source, window, signal)` that is not the global one, so a name match would flag it. Allowed:
an object literal with a `redirect` property (spreads may sit beside it), and a pure pass-through
`(input, init) => fetch(input, init)`. Not allowed: no init, an init without `redirect`, a spread
alone, a variable (state `redirect` where the call is).

## Add a rule

Follow `.claude/skills/add-lint-rule/SKILL.md`. In short:

1. Write `<ruleName>.test.ts` first, with ESLint's `RuleTester` (see `fetchRedirect.test.ts`):
   the real bug as an `invalid` case, today's correct code as `valid` cases.
2. Write `<ruleName>.mjs` exporting `ruleName` (camelCase); register it in `index.mjs` as
   `'rule-name'` (kebab case). `index.test.ts` fails when a file is not registered.
3. Turn it on in `eslint.config.js` with a narrow `files` scope. `pnpm lint` must stay green: fix
   each existing hit, or suppress it with `// eslint-disable-next-line digest/<rule> -- <why>`.
4. Prove it once: put the bug back, see `pnpm lint` fail, restore it.
5. Add a row to the table above and to the table in `.claude/skills/static-analysis/SKILL.md`.

Type information comes from `context.sourceCode.parserServices.program.getTypeChecker()`; the
typescript-eslint parser provides it for the files that `projectService` covers (all of `src` and
`evals`). A rule that needs it must say so in its error when the services are missing.
