---
name: add-lint-rule
description: Turn a bug class or project invariant into an automatic check so it cannot come back. Use after a review or incident finds a bug that a pattern could catch, when asked to "prevent this from happening again", or when adding a security invariant.
---

# Add a lint rule

A bug found by hand once will be written again. If a pattern (syntax, a type, a regex shape, an
import, a file) can show it, make the tool fail on it. Start from the real bug, not from the rule.

## Pick the tool

| The bug is...                                                      | Use                                                                                |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| a syntax pattern (a call without an argument, a banned construct)  | a local ESLint rule in `eslint-rules/` (below)                                     |
| visible only with types (the callee is the global `fetch`)         | the same, type-aware through `parserServices`                                      |
| a regex shape (backtracking, a useless group)                      | a `regexp/*` setting in `eslint.config.js`                                         |
| a dependency, file or export that nothing uses                     | `knip.json`                                                                        |
| a copy of existing code                                            | `.jscpd.json` already fails on growth; extract the code                            |
| two parts disagree for some input (render vs check, encode/decode) | a fast-check property test, like `test/integration/linkRoundTrip.property.test.ts` |
| a workflow or supply-chain weakness                                | zizmor (`pnpm lint:actions`) or CodeQL; fix the YAML, or add the query pack        |
| behaviour that needs a model, the network or a clock               | a plain test with fakes, not a rule                                                |

## New local rule, test first

1. **Tests.** Create `eslint-rules/<ruleName>.test.ts` with ESLint's `RuleTester` and the
   typescript-eslint parser (copy the setup of `fetchRedirect.test.ts`). `invalid`: the real bug,
   copied from the bug report, plus its near variants. `valid`: today's correct code, and the look-alike
   that is not the bug (the `SourceFetcher.fetch` method next to the global `fetch`). See them fail.
2. **Rule.** Create `eslint-rules/<ruleName>.mjs` and export `ruleName`. Register it in
   `eslint-rules/index.mjs` as `'rule-name'`; `index.test.ts` fails when a file is not registered.
3. **Scope.** Turn it on in `eslint.config.js` in its own block with a narrow `files` (and
   `ignores` for tests and `__fixtures__`). Name the invariant in a comment.
4. **Run on the repo.** `pnpm lint`. Fix each hit; if a hit is correct code, narrow the rule rather than
   suppress it; a suppression is `// eslint-disable-next-line digest/<rule> -- <why>`.
5. **Prove it.** Put the bug back once (copy the file aside first, then restore it byte for byte),
   see `pnpm lint` fail on exactly that line, restore.
6. **Document.** Add a row to `eslint-rules/README.md` and to the table in the `static-analysis`
   skill; add the invariant to `.claude/rules/` if it is a security one. Then `pnpm check` and `pnpm coverage`.

## Skeleton (from `fetchRedirect.mjs`)

```js
// @ts-check
/** @type {import('eslint').Rule.RuleModule} */
export const myRule = {
  meta: {
    type: 'problem',
    docs: { description: 'One sentence: what must hold.' },
    schema: [],
    messages: { broken: 'What is wrong, why it matters, how to fix it.' },
  },
  create(context) {
    const services = context.sourceCode.parserServices; // type-aware rules only
    if (!services?.program || !services.esTreeNodeToTSNodeMap) {
      throw new Error('digest/my-rule needs type information: set parserOptions.projectService.');
    }
    const checker = services.program.getTypeChecker();
    return {
      CallExpression(node) {
        const type = checker.getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(node.callee));
        const isTarget = type
          .getCallSignatures()
          .some((s) => s.getDeclaration()?.name?.text === 'fetch');
        if (isTarget) context.report({ node, messageId: 'broken' });
      },
    };
  },
};
```

Test setup: `RuleTester.describe = describe; RuleTester.it = it; RuleTester.itOnly = it.only;` then
`new RuleTester({ languageOptions: { parser: tseslint.parser, parserOptions: { projectService: {
allowDefaultProject: ['*.ts'] }, tsconfigRootDir: import.meta.dirname } } })`. Import the rule with its
`.mjs` extension. Give each case a `name`. A rule that needs no types can drop the `parserServices` lines.

## Gotchas

- Name the exact invariant in the message; a message that only says "don't" gets suppressed.
- Prefer a rule that cannot be fooled by a rename: ask the type checker, not the identifier text.
- Keep false positives at zero on the repo before turning it on; a noisy rule gets disabled.
