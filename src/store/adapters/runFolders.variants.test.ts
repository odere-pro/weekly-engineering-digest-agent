// A second run in a week writes variant digests (<week>-<slug>.md/.html) next to <week>.md:
// pruning an old week must keep them and still drop everything else.
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VARIANT_FILE_SUFFIX, pruneWeekFolder } from './runFolders';
import { weekDigestDir } from '../layout';
import { noopLogger } from '../../shared/telemetry';

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'runfolders-variants-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

async function prunedNames(names: readonly string[]): Promise<string[]> {
  const digestDir = weekDigestDir(dataDir, '2026-W30');
  await mkdir(digestDir, { recursive: true });
  for (const name of names) await writeFile(join(digestDir, name), name);
  await pruneWeekFolder({ dataDir, logger: noopLogger }, '2026-W30');
  return (await readdir(digestDir)).sort();
}

describe('pruneWeekFolder and variant digests', () => {
  it('keeps variant .md and .html files and drops run files and look-alikes', async () => {
    const left = await prunedNames([
      'digest.md',
      '2026-W30.md',
      '2026-W30-enriched.md',
      '2026-W30-perspective-security.html',
      'items.json',
      'run.json',
      '2026-W30-Bad.md',
      '2026-W30-x.txt',
      '2026-W30-enriched.json',
      '2026-W30-enriched.md.123.abc.tmp',
      '2026-W29-enriched.md',
      '2026-W30--bad.md',
    ]);

    expect(left).toEqual([
      '2026-W30-enriched.md',
      '2026-W30-perspective-security.html',
      '2026-W30.md',
      'digest.md',
    ]);
  });
});

describe('VARIANT_FILE_SUFFIX', () => {
  it('accepts a 60 character slug and refuses 61', () => {
    const slug = (n: number): string => `a${'b'.repeat(n - 1)}`;
    expect(VARIANT_FILE_SUFFIX.test(`-${slug(60)}.md`)).toBe(true);
    expect(VARIANT_FILE_SUFFIX.test(`-${slug(61)}.md`)).toBe(false);
  });
});
