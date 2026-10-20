import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMarkdownFileDelivery, digestFilePaths } from './markdownFile';

const message = { weekId: '2026-W42', subject: 's', markdown: '# Digest\n' };
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'delivery-variant-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('digestFilePaths', () => {
  it('names the files <week> without a variant and <week>-<variant> with one', () => {
    expect(digestFilePaths(dir, '2026-W42').markdown).toBe(join(dir, '2026-W42.md'));
    expect(digestFilePaths(dir, '2026-W42', 'enriched').html).toBe(
      join(dir, '2026-W42-enriched.html'),
    );
  });

  it.each(['', 'A', '-x', 'a/b', '../x', 'a.b', 'a b', 'x'.repeat(61)])(
    'refuses the variant %j',
    (variant) => {
      expect(() => digestFilePaths(dir, '2026-W42', variant)).toThrow(/invalid variant/);
    },
  );
});

describe('a variant digest', () => {
  it('is written beside the week digest and leaves it, its page and the failure note alone', async () => {
    const delivery = createMarkdownFileDelivery({ dir });
    await delivery.sendDigest(message);
    await writeFile(join(dir, '2026-W42.failed.md'), 'note');

    await delivery.sendDigest({ ...message, markdown: '# Variant\n', variant: 'complete' });

    expect((await readdir(dir)).sort()).toEqual([
      '2026-W42-complete.md',
      '2026-W42.failed.md',
      '2026-W42.md',
    ]);
    expect(await readFile(join(dir, '2026-W42.md'), 'utf8')).toBe('# Digest\n');
    expect(await readFile(join(dir, '2026-W42-complete.md'), 'utf8')).toBe('# Variant\n');
  });

  it('refuses a bad slug before writing anything', async () => {
    const delivery = createMarkdownFileDelivery({ dir });

    await expect(delivery.sendDigest({ ...message, variant: '../x' })).rejects.toThrow(
      /invalid variant/,
    );
    expect(await readdir(dir)).toEqual([]);
  });
});
