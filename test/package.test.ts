import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');

describe('package.json', () => {
  it('builds dist before pack, so the tarball never ships a stale or missing build', async () => {
    const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['prepack']).toBe('pnpm build');
    expect(pkg.scripts['build']).toBeDefined();
  });

  it('ships the build output, not the 26 MB of recorded evals', async () => {
    const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as {
      files: string[];
    };
    expect(pkg.files).toContain('dist/artifacts');
    expect(pkg.files.some((entry) => entry.startsWith('evals'))).toBe(false);
  });
});
