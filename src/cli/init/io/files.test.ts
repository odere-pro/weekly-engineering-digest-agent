import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isEmptyFile, mayExist, writeTextFile } from './files';

const isRoot = process.getuid?.() === 0;
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'digest-init-files-'));
});

afterEach(async () => {
  await chmod(dir, 0o700);
  await rm(dir, { recursive: true, force: true });
});

describe('mayExist', () => {
  it('is true for a file and for a folder', async () => {
    await writeFile(join(dir, 'a.txt'), 'x');

    expect(await mayExist(join(dir, 'a.txt'))).toBe(true);
    expect(await mayExist(dir)).toBe(true);
  });

  it('is false for a path that is not there', async () => {
    expect(await mayExist(join(dir, 'missing.txt'))).toBe(false);
  });

  it('is false for a path below a file (ENOTDIR)', async () => {
    await writeFile(join(dir, 'a.txt'), 'x');

    expect(await mayExist(join(dir, 'a.txt', 'below'))).toBe(false);
  });

  it('is true when it cannot tell (a link that loops), so the caller asks before overwriting', async () => {
    await symlink(join(dir, 'loop'), join(dir, 'loop'));

    expect(await mayExist(join(dir, 'loop'))).toBe(true);
  });

  it.skipIf(isRoot)(
    'is true when it cannot tell (a folder it may not search), so the caller asks before overwriting',
    async () => {
      await writeFile(join(dir, 'a.txt'), 'x');
      await chmod(dir, 0o000);

      expect(await mayExist(join(dir, 'a.txt'))).toBe(true);
    },
  );
});

describe('writeTextFile', () => {
  it('writes the text', async () => {
    const file = join(dir, 'a.json');

    await writeTextFile(file, '{"a":1}\n');

    expect(await readFile(file, 'utf8')).toBe('{"a":1}\n');
  });

  it('creates the folders on the way', async () => {
    const file = join(dir, 'conf', 'deep', 'a.json');

    await writeTextFile(file, 'x');

    expect(await readFile(file, 'utf8')).toBe('x');
  });

  it('replaces what was there rather than adding to it', async () => {
    const file = join(dir, 'a.json');
    await writeFile(file, 'a much longer old text');

    await writeTextFile(file, 'new');

    expect(await readFile(file, 'utf8')).toBe('new');
  });

  it('rejects when the folder cannot be created', async () => {
    await writeFile(join(dir, 'file'), 'x');

    await expect(writeTextFile(join(dir, 'file', 'a.json'), 'x')).rejects.toThrow();
  });
});

describe('isEmptyFile', () => {
  it('is true for a file with no content, as make docker-init creates', async () => {
    await writeFile(join(dir, 'empty'), '');

    expect(await isEmptyFile(join(dir, 'empty'))).toBe(true);
  });

  it('is false for a file with content', async () => {
    await writeFile(join(dir, 'full'), 'x');

    expect(await isEmptyFile(join(dir, 'full'))).toBe(false);
  });

  it('is false for a folder', async () => {
    await mkdir(join(dir, 'folder'));

    expect(await isEmptyFile(join(dir, 'folder'))).toBe(false);
  });

  it('is false for a path it cannot stat, so the caller asks before overwriting', async () => {
    expect(await isEmptyFile(join(dir, 'missing'))).toBe(false);
  });
});
