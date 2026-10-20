import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { digest } from './index.mjs';

const RULE_FILES = readdirSync(import.meta.dirname).filter(
  (name) => name.endsWith('.mjs') && name !== 'index.mjs',
);

/** `fetchRedirect.mjs` registers as `fetch-redirect`: the file name in kebab case. */
const ruleNameOf = (file: string): string =>
  file.replace(/\.mjs$/, '').replaceAll(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

describe('the digest ESLint plugin', () => {
  it('registers every rule file of this folder, under the file name in kebab case', () => {
    expect(RULE_FILES.length).toBeGreaterThan(0);
    expect(Object.keys(digest.rules ?? {}).sort()).toEqual(RULE_FILES.map(ruleNameOf).sort());
  });

  it('gives every rule a message for each problem it reports', () => {
    for (const [name, rule] of Object.entries(digest.rules ?? {})) {
      expect(Object.keys(rule.meta?.messages ?? {}), name).not.toHaveLength(0);
    }
  });
});
