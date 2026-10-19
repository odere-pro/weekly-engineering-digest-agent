import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isEmptyFile, pathExists, readTextIfPresent, writeTextFile } from './files';

const isRoot = process.getuid?.() === 0;
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'digest-init-files-'));
});

afterEach(async () => {
  await chmod(dir, 0o700);
  await rm(dir, { recursive: true, force: true });
});

describe('pathExists', () => {
  it('is true for a file and for a folder', async () => {
    await writeFile(join(dir, 'a.txt'), 'x');

    expect(await pathExists(join(dir, 'a.txt'))).toBe(true);
    expect(await pathExists(dir)).toBe(true);
  });

  it('is false for a path that is not there', async () => {
    expect(await pathExists(join(dir, 'missing.txt'))).toBe(false);
  });

  it('is false for a path below a file (ENOTDIR)', async () => {
    await writeFile(join(dir, 'a.txt'), 'x');

    expect(await pathExists(join(dir, 'a.txt', 'below'))).toBe(false);
  });

  it.skipIf(isRoot)(
    'is true when it cannot tell, so the caller asks before overwriting',
    async () => {
      await writeFile(join(dir, 'a.txt'), 'x');
      await chmod(dir, 0o000);

      expect(await pathExists(join(dir, 'a.txt'))).toBe(true);
    },
  );
});

describe('readTextIfPresent', () => {
  it('returns the text of a file', async () => {
    await writeFile(join(dir, 'a.txt'), 'héllo\n', 'utf8');

    expect(await readTextIfPresent(join(dir, 'a.txt'))).toBe('héllo\n');
  });

  it('returns an empty string for an empty file', async () => {
    await writeFile(join(dir, 'a.txt'), '');

    expect(await readTextIfPresent(join(dir, 'a.txt'))).toBe('');
  });

  it('returns undefined for a file that is not there', async () => {
    expect(await readTextIfPresent(join(dir, 'missing.txt'))).toBeUndefined();
  });

  it('rejects for any other failure, such as reading a folder', async () => {
    await expect(readTextIfPresent(dir)).rejects.toMatchObject({ code: 'EISDIR' });
  });

  it.skipIf(isRoot)('rejects for a file it may not read', async () => {
    const file = join(dir, 'secret.txt');
    await writeFile(file, 'x');
    await chmod(file, 0o000);

    await expect(readTextIfPresent(file)).rejects.toMatchObject({ code: 'EACCES' });
  });
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
