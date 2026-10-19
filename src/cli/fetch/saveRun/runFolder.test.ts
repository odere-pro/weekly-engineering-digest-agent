import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { useTempDir } from '../__fixtures__/fetchHarness';
import { createRunFolder, runFolderOf } from './runFolder';

const dir = useTempDir();

describe('runFolderOf', () => {
  it('is the day folder below the data folder', () => {
    expect(runFolderOf({ root: '/data', day: '2026-10-13' })).toBe(join('/data', '2026-10-13'));
  });
});

describe('createRunFolder', () => {
  it('creates the day folder and the data folder above it, and returns the path', async () => {
    const root = join(dir(), 'new', 'data');

    const folder = await createRunFolder({ root, day: '2026-10-13' });

    expect(folder).toBe(join(root, '2026-10-13'));
    expect(await readdir(root)).toEqual(['2026-10-13']);
  });

  it('is fine with a folder that is already there, and keeps what is in it', async () => {
    const folder = join(dir(), '2026-10-13');
    await mkdir(join(folder, 'example-feed'), { recursive: true });
    await writeFile(join(folder, 'fetch-summary.json'), 'earlier');

    await createRunFolder({ root: dir(), day: '2026-10-13' });

    expect((await readdir(folder)).sort()).toEqual(['example-feed', 'fetch-summary.json']);
  });

  it('fails with the reason when a file is in the way', async () => {
    await writeFile(join(dir(), 'taken'), 'a file, not a folder');

    await expect(
      createRunFolder({ root: join(dir(), 'taken'), day: '2026-10-13' }),
    ).rejects.toThrow(/ENOTDIR|EEXIST/);
  });
});
