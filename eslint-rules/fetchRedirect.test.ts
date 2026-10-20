import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, it } from 'vitest';
import { fetchRedirect } from './fetchRedirect.mjs';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

// Type information is what the rule is about: the parser reads the repo's tsconfig (so `fetch` is
// the one from @types/node) and treats the cases as `file.ts` in this folder.
const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: {
      projectService: { allowDefaultProject: ['*.ts'] },
      tsconfigRootDir: import.meta.dirname,
    },
  },
});

const PORT = `
  interface Source { readonly id: string }
  interface SourceFetcher {
    fetch(source: Source, window: number, signal?: AbortSignal): Promise<string[]>;
  }
`;

ruleTester.run('fetch-redirect', fetchRedirect, {
  valid: [
    {
      name: 'the global fetch with an init that states redirect',
      code: `await fetch('https://example.test', { method: 'GET', redirect: 'manual' });`,
    },
    {
      name: 'globalThis.fetch with redirect',
      code: `await globalThis.fetch('https://example.test', { redirect: 'error' });`,
    },
    {
      name: 'an injected fetch typed as typeof fetch, spread next to redirect (the Ollama client)',
      code: `
        declare const init: RequestInit;
        export const send = (fetchFn: typeof fetch, url: string) =>
          fetchFn(url, { ...init, redirect: 'manual' });
      `,
    },
    {
      name: 'redirect given as a string key, a shorthand or through as and satisfies',
      code: `
        const redirect = 'manual';
        void fetch('https://a.test', { 'redirect': 'manual' });
        void fetch('https://b.test', { redirect });
        void fetch('https://c.test', { redirect: 'manual' } as RequestInit);
        void fetch('https://d.test', { redirect: 'manual' } satisfies RequestInit);
      `,
    },
    {
      name: 'a pass-through wrapper forwards its caller init',
      code: `export const wrapped: typeof fetch = (input, init) => globalThis.fetch(input, init);`,
    },
    {
      name: 'a pass-through function declaration',
      code: `export function passThrough(input: string | URL, init?: RequestInit) { return fetch(input, init); }`,
    },
    {
      name: 'the SourceFetcher port is not the global fetch',
      code: `${PORT}
        export const run = (fetcher: SourceFetcher, source: Source, signal: AbortSignal) =>
          fetcher.fetch(source, 7, signal);
      `,
    },
    {
      name: 'an object method that happens to be called fetch',
      code: `
        const client = { fetch(a: string, b: number) { return a + b.toString(); } };
        client.fetch('x', 1);
      `,
    },
    {
      name: 'a function typed any is not known to be fetch',
      code: `declare const unknownFetch: any; unknownFetch('https://example.test');`,
    },
  ],
  invalid: [
    {
      name: 'a call without any init',
      code: `await fetch('https://example.test');`,
      errors: [{ messageId: 'missingRedirect' }],
    },
    {
      name: 'an object literal without redirect',
      code: `await fetch('https://example.test', { method: 'POST', body: 'x' });`,
      errors: [{ messageId: 'missingRedirect' }],
    },
    {
      name: 'an init that is only a spread',
      code: `
        declare const init: RequestInit;
        await fetch('https://example.test', { ...init });
      `,
      errors: [{ messageId: 'missingRedirect' }],
    },
    {
      name: 'the real bug: an injected fetchFn(url, init) where init has no redirect',
      code: `
        type SendInit = RequestInit & { signal: AbortSignal };
        export async function send(fetchFn: typeof fetch, root: string, path: string, init: SendInit) {
          const url = root + path;
          return fetchFn(url, init);
        }
      `,
      errors: [{ messageId: 'missingRedirect' }],
    },
    {
      name: 'a wrapper that rewrites the init instead of forwarding it',
      code: `
        export const wrapped: typeof fetch = (input, init) =>
          globalThis.fetch(input, { ...init, signal: AbortSignal.timeout(1000) });
      `,
      errors: [{ messageId: 'missingRedirect' }],
    },
    {
      name: 'a fetch held in a variable',
      code: `
        const f = globalThis.fetch;
        await f('https://example.test', { method: 'GET' });
      `,
      errors: [{ messageId: 'missingRedirect' }],
    },
    {
      name: 'an init held in a variable (state redirect where the call is)',
      code: `
        const init = { method: 'GET', redirect: 'manual' } as const;
        await fetch('https://example.test', init);
      `,
      errors: [{ messageId: 'missingRedirect' }],
    },
  ],
});
