// @ts-check
// digest/fetch-redirect: every call to the global `fetch` (or a function typed as it, such as an
// injected `fetchFn: typeof fetch`) must state `redirect` in its init.
//
// Why: fetch follows redirects by default. A 307/308 from a configured host would then resend the
// request, and its body, to a host the user never configured. The Ollama client did exactly that
// with prompts that carry collected feed text (security invariant 4, .claude/rules/security.md).
//
// Type-aware on purpose: the `SourceFetcher` port has a method named `fetch(source, window,
// signal)`. It is not the global `fetch`, so a name match would flag it. The rule asks the type
// checker instead: does the callee's call signature come from a declaration of a function named
// `fetch` in a .d.ts file (the lib or `@types/node`)?

/** @typedef {import('eslint').Rule.RuleModule} RuleModule */

const MESSAGES = {
  missingRedirect:
    "This fetch call does not state `redirect`. Pass an init with `redirect: 'manual'` or `'error'` (an object literal, spreads allowed): the default follows a 307/308 to a host nobody configured (security invariant 4).",
};

/**
 * `as`, `satisfies`, `<T>x` and `x!` change the type, not the value: look through them.
 * @param {any} node
 * @returns {any}
 */
function unwrap(node) {
  let current = node;
  while (
    current &&
    ['TSAsExpression', 'TSSatisfiesExpression', 'TSTypeAssertion', 'TSNonNullExpression'].includes(
      current.type,
    )
  ) {
    current = current.expression;
  }
  return current;
}

/**
 * True when the object literal has a `redirect` property. A spread does not count: it may or may
 * not carry one, and the reader cannot tell.
 * @param {any} objectExpression
 */
function statesRedirect(objectExpression) {
  return objectExpression.properties.some(
    /** @param {any} property */
    (property) => {
      if (property.type !== 'Property') return false;
      const { key } = property;
      if (!property.computed && key.type === 'Identifier') return key.name === 'redirect';
      return key.type === 'Literal' && key.value === 'redirect';
    },
  );
}

/**
 * The nearest function around `node`.
 * @param {any} node
 */
function enclosingFunction(node) {
  let current = node.parent;
  while (current) {
    if (
      current.type === 'ArrowFunctionExpression' ||
      current.type === 'FunctionExpression' ||
      current.type === 'FunctionDeclaration'
    ) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

/**
 * `(input, init) => fetch(input, init)`: the call hands on the first two parameters of its own
 * function, in order. The caller's init reaches fetch untouched, so the caller states `redirect`.
 * `send(path, init) { fetchFn(url, init) }` is not that: `url` is not a parameter.
 * @param {any} call
 */
function forwardsItsParameters(call) {
  const fn = enclosingFunction(call);
  const [url, init] = call.arguments;
  if (!fn || !url || !init) return false;
  const [firstParam, secondParam] = fn.params;
  return (
    firstParam?.type === 'Identifier' &&
    secondParam?.type === 'Identifier' &&
    url.type === 'Identifier' &&
    init.type === 'Identifier' &&
    url.name === firstParam.name &&
    init.name === secondParam.name
  );
}

/** @type {RuleModule} */
export const fetchRedirect = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Require every global fetch call to state `redirect` in its init.',
    },
    schema: [],
    messages: MESSAGES,
  },
  create(context) {
    const services = context.sourceCode.parserServices;
    if (!services?.program || !services.esTreeNodeToTSNodeMap) {
      throw new Error(
        'digest/fetch-redirect needs type information: set languageOptions.parserOptions.projectService.',
      );
    }
    const checker = services.program.getTypeChecker();

    /**
     * True when the call signatures of `callee` are declared by a function named `fetch` in a
     * declaration file, whatever name the caller holds it under.
     * @param {any} callee
     */
    function isGlobalFetch(callee) {
      const type = checker.getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(callee));
      return type.getCallSignatures().some(
        /** @param {any} signature */
        (signature) => {
          const declaration = signature.getDeclaration();
          return (
            declaration?.name?.text === 'fetch' && declaration.getSourceFile().isDeclarationFile
          );
        },
      );
    }

    return {
      CallExpression(node) {
        if (!isGlobalFetch(node.callee)) return;
        const init = unwrap(node.arguments[1]);
        if (init?.type === 'ObjectExpression' && statesRedirect(init)) return;
        if (forwardsItsParameters(node)) return;
        context.report({ node, messageId: 'missingRedirect' });
      },
    };
  },
};
