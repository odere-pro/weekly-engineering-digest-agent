import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { errnoCode, isNotFound, pathExists } from './fsErrors';

const isRoot = process.getuid?.() === 0;

const errno = (code: string): Error => Object.assign(new Error(`${code}: failed`), { code });

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fserrors-'));
});

afterEach(async () => {
  await chmod(dir, 0o700);
  await rm(dir, { recursive: true, force: true });
});

describe('errnoCode', () => {
  it('reads the code of a Node system error', () => {
    expect(errnoCode(errno('EACCES'))).toBe('EACCES');
  });

  it('reads the code of an error the file system really threw', async () => {
    const error = await stat(join(dir, 'missing')).catch((caught: unknown) => caught);

    expect(errnoCode(error)).toBe('ENOENT');
  });

  it('is undefined for an error with no code', () => {
    expect(errnoCode(new Error('plain'))).toBeUndefined();
  });

  it('is undefined when the code is not a string', () => {
    expect(errnoCode(Object.assign(new Error('odd'), { code: 13 }))).toBeUndefined();
  });

  it('is undefined for a value that is not an Error, even one that carries a code', () => {
    expect(errnoCode({ code: 'ENOENT' })).toBeUndefined();
    expect(errnoCode('ENOENT')).toBeUndefined();
    expect(errnoCode(undefined)).toBeUndefined();
    expect(errnoCode(null)).toBeUndefined();
  });
});

describe('isNotFound', () => {
  it.each(['ENOENT', 'ENOTDIR'])('is true for %s: the path is not there', (code) => {
    expect(isNotFound(errno(code))).toBe(true);
  });

  it.each(['EACCES', 'EIO', 'EISDIR', 'ELOOP', 'EEXIST'])('is false for %s', (code) => {
    expect(isNotFound(errno(code))).toBe(false);
  });

  it('is false for a message that merely names the code', () => {
    expect(isNotFound(new Error('ENOENT: no such file'))).toBe(false);
  });

  it('is false for a value that is not an Error', () => {
    expect(isNotFound({ code: 'ENOENT' })).toBe(false);
    expect(isNotFound('ENOENT')).toBe(false);
    expect(isNotFound(undefined)).toBe(false);
  });
});

describe('pathExists', () => {
  it('is true for a file and for a folder', async () => {
    await writeFile(join(dir, 'a.txt'), 'x');

    expect(await pathExists(join(dir, 'a.txt'))).toBe(true);
    expect(await pathExists(dir)).toBe(true);
  });

  it('is true for an empty file', async () => {
    await writeFile(join(dir, 'empty'), '');

    expect(await pathExists(join(dir, 'empty'))).toBe(true);
  });

  it('is false for a path that is not there', async () => {
    expect(await pathExists(join(dir, 'missing.txt'))).toBe(false);
  });

  it('is false for a path below a file (ENOTDIR)', async () => {
    await writeFile(join(dir, 'a.txt'), 'x');

    expect(await pathExists(join(dir, 'a.txt', 'below'))).toBe(false);
  });

  it('follows a link: true for a link to a file, false for a dangling one', async () => {
    await writeFile(join(dir, 'target'), 'x');
    await symlink(join(dir, 'target'), join(dir, 'good'));
    await symlink(join(dir, 'gone'), join(dir, 'dangling'));

    expect(await pathExists(join(dir, 'good'))).toBe(true);
    expect(await pathExists(join(dir, 'dangling'))).toBe(false);
  });

  it('rethrows what is not a missing path: a link that loops (ELOOP)', async () => {
    await symlink(join(dir, 'loop'), join(dir, 'loop'));

    await expect(pathExists(join(dir, 'loop'))).rejects.toMatchObject({ code: 'ELOOP' });
  });

  it.skipIf(isRoot)('rethrows a folder it may not search (EACCES)', async () => {
    const folder = join(dir, 'closed');
    await mkdir(folder);
    await writeFile(join(folder, 'a.txt'), 'x');
    await chmod(folder, 0o000);

    try {
      await expect(pathExists(join(folder, 'a.txt'))).rejects.toMatchObject({ code: 'EACCES' });
    } finally {
      await chmod(folder, 0o700); // so the clean-up can remove it
    }
  });
});
