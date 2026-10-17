import { randomUUID } from 'node:crypto';
import {
  lutimes,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFileExclusive,
  isErrnoException,
  readTextIfExists,
  removeStaleTempFiles,
  writeFileAtomic,
} from '../../../src/adapters/store/atomicFile.js';
import type * as Fs from 'node:fs/promises';

// A test can make the clean-up after a write vanish (a writer killed mid-write), make linking
// fail (a file system without hard links), or make removing a file fail, each with an error code.
const faults = vi.hoisted(() => ({
  skipNextRm: false,
  failLinkWith: undefined as string | undefined,
  failUnlinkFor: undefined as { suffix: string; code: string } | undefined,
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>();
  return {
    ...actual,
    rm: (path: string, options?: Parameters<typeof Fs.rm>[1]) => {
      if (faults.skipNextRm) {
        faults.skipNextRm = false;
        return Promise.resolve();
      }
      return actual.rm(path, options);
    },
    link: (existing: string, created: string) =>
      faults.failLinkWith === undefined
        ? actual.link(existing, created)
        : Promise.reject(
            Object.assign(new Error(`${faults.failLinkWith}: link not supported`), {
              code: faults.failLinkWith,
            }),
          ),
    unlink: (path: string) => {
      const { suffix, code } = faults.failUnlinkFor ?? {};
      if (suffix !== undefined && path.endsWith(suffix)) {
        return Promise.reject(Object.assign(new Error(`${code ?? ''} on ${suffix}`), { code }));
      }
      return actual.unlink(path);
    },
  };
});

const NOW = new Date('2026-10-19T08:00:00.000Z');
const MINUTE_MS = 60_000;
const MAX_AGE_MS = 10 * MINUTE_MS;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atomicfile-'));
  faults.skipNextRm = false;
  faults.failLinkWith = undefined;
  faults.failUnlinkFor = undefined;
});

afterEach(async () => {
  faults.skipNextRm = false;
  faults.failLinkWith = undefined;
  faults.failUnlinkFor = undefined;
  await rm(dir, { recursive: true, force: true });
});

const tempName = (base: string, pid = 4242): string => `${base}.${String(pid)}.${randomUUID()}.tmp`;

/** Writes a file whose last change was `ageMs` before NOW. */
async function writeAged(name: string, ageMs: number): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, 'x');
  const modified = new Date(NOW.getTime() - ageMs);
  await utimes(path, modified, modified);
  return path;
}

const names = async (): Promise<string[]> => (await readdir(dir)).sort();

describe('writeFileAtomic', () => {
  it('writes the content and leaves no temp file behind', async () => {
    const path = join(dir, 'file.json');

    await writeFileAtomic(path, '{"a":1}');

    expect(await readFile(path, 'utf8')).toBe('{"a":1}');
    expect(await names()).toEqual(['file.json']);
  });

  it('replaces existing content in one step', async () => {
    const path = join(dir, 'file.json');
    await writeFileAtomic(path, 'first');

    await writeFileAtomic(path, 'second');

    expect(await readFile(path, 'utf8')).toBe('second');
  });

  it('removes its temp file and rethrows when the rename fails', async () => {
    const path = join(dir, 'taken');
    await mkdir(join(path, 'inside'), { recursive: true });

    await expect(writeFileAtomic(path, 'content')).rejects.toThrow();

    expect(await names()).toEqual(['taken']);
  });
});

describe('createFileExclusive', () => {
  it('creates the file with its complete content and leaves no temp file behind', async () => {
    const path = join(dir, 'lock');

    await expect(createFileExclusive(path, 'mine')).resolves.toBe(true);

    expect(await readFile(path, 'utf8')).toBe('mine');
    expect(await names()).toEqual(['lock']);
  });

  it('returns false and keeps the existing content when the file exists', async () => {
    const path = join(dir, 'lock');
    await createFileExclusive(path, 'first');

    await expect(createFileExclusive(path, 'second')).resolves.toBe(false);

    expect(await readFile(path, 'utf8')).toBe('first');
    expect(await names()).toEqual(['lock']);
  });

  it('rethrows an error other than "exists"', async () => {
    const path = join(dir, 'missing-folder', 'lock');

    await expect(createFileExclusive(path, 'mine')).rejects.toThrow(/ENOENT/);
  });

  it('rethrows a link failure, as on a file system without hard links, and cleans up', async () => {
    faults.failLinkWith = 'ENOTSUP';

    await expect(createFileExclusive(join(dir, 'lock'), 'mine')).rejects.toSatisfy(
      (error: unknown) => isErrnoException(error, 'ENOTSUP'),
    );

    expect(await names()).toEqual([]);
  });
});

describe('readTextIfExists', () => {
  it('reads the file', async () => {
    await writeFile(join(dir, 'file'), 'text');

    await expect(readTextIfExists(join(dir, 'file'))).resolves.toBe('text');
  });

  it('returns undefined for a file that does not exist', async () => {
    await expect(readTextIfExists(join(dir, 'nope'))).resolves.toBeUndefined();
  });

  it('propagates other errors', async () => {
    await expect(readTextIfExists(dir)).rejects.toSatisfy((error: unknown) =>
      isErrnoException(error, 'EISDIR'),
    );
  });
});

describe('isErrnoException', () => {
  it('matches an Error with the code, and nothing else', () => {
    expect(isErrnoException(Object.assign(new Error('x'), { code: 'EEXIST' }), 'EEXIST')).toBe(
      true,
    );
    expect(isErrnoException(Object.assign(new Error('x'), { code: 'EPERM' }), 'EEXIST')).toBe(
      false,
    );
    expect(isErrnoException(new Error('x'), 'EEXIST')).toBe(false);
    expect(isErrnoException({ code: 'EEXIST' }, 'EEXIST')).toBe(false);
    expect(isErrnoException('EEXIST', 'EEXIST')).toBe(false);
  });
});

describe('removeStaleTempFiles', () => {
  const lockPath = (): string => join(dir, 'digest.lock');
  const sweep = (fileNames: string[] = ['digest.lock'], folder = dir) =>
    removeStaleTempFiles(folder, fileNames, { maxAgeMs: MAX_AGE_MS, now: NOW });

  it('removes a temp file once it is as old as the limit, and reports it', async () => {
    const name = tempName('digest.lock');
    await writeAged(name, MAX_AGE_MS);

    const result = await sweep();

    expect(result).toEqual({ removed: [name], failed: [] });
    expect(await names()).toEqual([]);
  });

  it('keeps a temp file that is younger than the limit: its writer may still be running', async () => {
    const name = tempName('digest.lock');
    await writeAged(name, MAX_AGE_MS - 1000);

    const result = await sweep();

    expect(result).toEqual({ removed: [], failed: [] });
    expect(await names()).toEqual([name]);
  });

  it('keeps a temp file whose change time is in the future (a clock that was ahead)', async () => {
    const name = tempName('digest.lock');
    await writeAged(name, -MAX_AGE_MS);

    await sweep();

    expect(await names()).toEqual([name]);
  });

  it('sweeps old files and keeps fresh ones in the same folder', async () => {
    const old = tempName('digest.lock', 1);
    const fresh = tempName('digest.lock', 2);
    await writeAged(old, 2 * MAX_AGE_MS);
    await writeAged(fresh, MINUTE_MS);

    const result = await sweep();

    expect(result.removed).toEqual([old]);
    expect(await names()).toEqual([fresh]);
  });

  it('sweeps the temp files of every name it is given', async () => {
    const forLock = tempName('digest.lock');
    const forGuard = tempName('digest.lock.takeover');
    await writeAged(forLock, 2 * MAX_AGE_MS);
    await writeAged(forGuard, 2 * MAX_AGE_MS);

    const result = await sweep(['digest.lock', 'digest.lock.takeover']);

    expect([...result.removed].sort()).toEqual([forLock, forGuard].sort());
    expect(await names()).toEqual([]);
  });

  it('only sweeps the temp files of the names it is given', async () => {
    const forGuard = tempName('digest.lock.takeover');
    await writeAged(forGuard, 2 * MAX_AGE_MS);

    await sweep(['digest.lock']);

    expect(await names()).toEqual([forGuard]);
  });

  it('leaves foreign files alone, however old', async () => {
    const foreign = [
      'digest.lock',
      'digest.lock.takeover',
      'notes.tmp',
      'digest.lock.tmp',
      'digest.lock..tmp',
      'digest.lock.backup',
      'digest.lock.bak.tmp',
      'digest.lock.4242.not-a-uuid.tmp',
      `digest.lock.4242.${randomUUID()}.tmp.old`,
      `digest.lock.pid.${randomUUID()}.tmp`,
      tempName('digest.lockfile'),
      tempName('other.json'),
      tempName('xdigest.lock'),
    ];
    for (const name of foreign) await writeAged(name, 24 * 60 * MINUTE_MS);

    const result = await sweep();

    expect(result).toEqual({ removed: [], failed: [] });
    expect(await names()).toEqual([...foreign].sort());
  });

  it('leaves a directory or a symlink with a temp file name alone', async () => {
    const directory = tempName('digest.lock', 1);
    const linkToOldFile = tempName('digest.lock', 2);
    const dangling = tempName('digest.lock', 3);
    const target = await writeAged('target-file', 2 * MAX_AGE_MS);
    await mkdir(join(dir, directory));
    await symlink(target, join(dir, linkToOldFile));
    await symlink(join(dir, 'nothing-here'), join(dir, dangling));
    const old = new Date(NOW.getTime() - 2 * MAX_AGE_MS);
    await utimes(join(dir, directory), old, old);
    await lutimes(join(dir, linkToOldFile), old, old);

    const result = await sweep();

    expect(result).toEqual({ removed: [], failed: [] });
    expect(await names()).toEqual([directory, linkToOldFile, dangling, 'target-file'].sort());
    await expect(readFile(target, 'utf8')).resolves.toBe('x');
  });

  it('does nothing when the folder does not exist', async () => {
    const result = await sweep(['digest.lock'], join(dir, 'missing'));

    expect(result).toEqual({ removed: [], failed: [] });
  });

  it('throws when the folder cannot be read', async () => {
    await writeFile(join(dir, 'a-file'), 'x');

    await expect(sweep(['digest.lock'], join(dir, 'a-file'))).rejects.toSatisfy((error: unknown) =>
      isErrnoException(error, 'ENOTDIR'),
    );
  });

  it('sweeps the temp file a writer killed halfway leaves behind', async () => {
    // The writer died after creating its temp file and before cleaning it up.
    faults.skipNextRm = true;
    await expect(createFileExclusive(lockPath(), 'mine')).resolves.toBe(true);
    await writeAged(
      (await names()).find((name) => name.endsWith('.tmp')) ?? 'no-temp-file-was-left',
      2 * MAX_AGE_MS,
    );
    expect(await names()).toHaveLength(2);

    const result = await sweep();

    expect(result.removed).toHaveLength(1);
    expect(await names()).toEqual(['digest.lock']);
  });

  it('reports a file it cannot remove and still removes the others', async () => {
    const stuck = tempName('digest.lock', 1);
    const other = tempName('digest.lock', 2);
    await writeAged(stuck, 2 * MAX_AGE_MS);
    await writeAged(other, 2 * MAX_AGE_MS);
    faults.failUnlinkFor = { suffix: stuck, code: 'EPERM' };

    const result = await sweep();

    expect(result).toEqual({
      removed: [other],
      failed: [{ name: stuck, error: `EPERM on ${stuck}` }],
    });
    expect(await names()).toEqual([stuck]);
  });

  it('does not count, or report, a file that another run removed in the meantime', async () => {
    const name = tempName('digest.lock');
    await writeAged(name, 2 * MAX_AGE_MS);
    faults.failUnlinkFor = { suffix: name, code: 'ENOENT' };

    const result = await sweep();

    expect(result).toEqual({ removed: [], failed: [] });
  });
});
