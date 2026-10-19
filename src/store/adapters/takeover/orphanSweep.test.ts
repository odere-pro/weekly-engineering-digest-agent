import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { sweepOrphanedTempFiles } from './orphanSweep';
import { ORPHANED_TEMP_MAX_AGE_MS } from '../lockState/lockTimings';
import { noopLogger, type Logger } from '../../../shared/telemetry';
import type * as AtomicFile from '../../../shared/atomicFile';

// The sweep goes through removeStaleTempFiles; a test can make it fail or report a stuck file.
const atomic = vi.hoisted(() => ({ failSweep: false, stuckFile: false }));
vi.mock('../../../shared/atomicFile', async (importOriginal) => {
  const actual = await importOriginal<typeof AtomicFile>();
  return {
    ...actual,
    removeStaleTempFiles: (...args: Parameters<typeof actual.removeStaleTempFiles>) => {
      if (atomic.failSweep) return Promise.reject(new Error('folder unreadable'));
      if (atomic.stuckFile) {
        const failed = [{ name: 'digest.lock.1.stuck.tmp', error: 'operation not permitted' }];
        return Promise.resolve({ removed: [], failed });
      }
      return actual.removeStaleTempFiles(...args);
    },
  };
});

// Long ago, so that the real modification time of a temp file made while a test runs always lies
// in the future of this clock, and the sweep keeps it.
const NOW = '2026-01-05T08:00:00.000Z';
const SECOND_MS = 1000;
const HOUR_MS = 3_600_000;

let dir: string;
let lockPath: string;
let warn: Mock<Logger['warn']>;
let logger: Logger;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orphansweep-'));
  lockPath = join(dir, 'digest.lock');
  atomic.failSweep = false;
  atomic.stuckFile = false;
  warn = vi.fn<Logger['warn']>();
  logger = { ...noopLogger, warn, child: () => logger };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const tempName = (base: string, pid = 4242): string => `${base}.${String(pid)}.${randomUUID()}.tmp`;

/** A file in the lock folder whose last change was `ageMs` before the lock clock's now. */
async function writeAged(name: string, ageMs: number): Promise<void> {
  await writeFile(join(dir, name), 'x');
  const modified = new Date(Date.parse(NOW) - ageMs);
  await utimes(join(dir, name), modified, modified);
}

const names = async (): Promise<string[]> => (await readdir(dir)).sort();

const sweep = (): Promise<void> =>
  sweepOrphanedTempFiles({ lockPath, clock: { now: () => new Date(NOW) }, logger });

describe('sweepOrphanedTempFiles', () => {
  it('removes temp files of the lock once they are 10 minutes old, and says so', async () => {
    const orphan = tempName('digest.lock');
    await writeAged(orphan, ORPHANED_TEMP_MAX_AGE_MS);

    await sweep();

    expect(await names()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('Removed orphaned run lock temp files', { files: [orphan] });
  });

  it('keeps them while younger than 10 minutes, because their writer may be running', async () => {
    const fresh = tempName('digest.lock');
    await writeAged(fresh, ORPHANED_TEMP_MAX_AGE_MS - SECOND_MS);

    await sweep();

    expect(await names()).toEqual([fresh]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('removes the temp files of the takeover guard as well', async () => {
    const orphan = tempName('digest.lock.takeover');
    await writeAged(orphan, 3 * ORPHANED_TEMP_MAX_AGE_MS);

    await sweep();

    expect(await names()).toEqual([]);
  });

  it('leaves the lock and the guard themselves alone, old as they are', async () => {
    await writeAged('digest.lock', 24 * HOUR_MS);
    await writeAged('digest.lock.takeover', 24 * HOUR_MS);

    await sweep();

    expect(await names()).toEqual(['digest.lock', 'digest.lock.takeover']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('leaves foreign files alone, old as they are', async () => {
    const foreign = [
      'notes.tmp',
      'digest.lock.bak',
      tempName('digest.json'),
      tempName('other.lock'),
    ];
    for (const name of foreign) await writeAged(name, 24 * HOUR_MS);

    await sweep();

    expect(await names()).toEqual([...foreign].sort());
    expect(warn).not.toHaveBeenCalled();
  });

  it('follows the name of the lock file it is given', async () => {
    lockPath = join(dir, 'other.lock');
    const mine = tempName('other.lock');
    const notMine = tempName('digest.lock');
    await writeAged(mine, 2 * ORPHANED_TEMP_MAX_AGE_MS);
    await writeAged(notMine, 2 * ORPHANED_TEMP_MAX_AGE_MS);

    await sweep();

    expect(await names()).toEqual([notMine]);
  });

  it('does nothing, quietly, when the folder does not exist', async () => {
    lockPath = join(dir, 'missing', 'digest.lock');

    await expect(sweep()).resolves.toBeUndefined();

    expect(warn).not.toHaveBeenCalled();
  });

  it('never raises: a failed sweep is logged', async () => {
    atomic.failSweep = true;

    await expect(sweep()).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith('Could not sweep orphaned run lock temp files', {
      error: 'folder unreadable',
    });
  });

  it('reports a file that cannot be removed', async () => {
    atomic.stuckFile = true;

    await expect(sweep()).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('Could not remove orphaned run lock temp files', {
      failed: [{ name: 'digest.lock.1.stuck.tmp', error: 'operation not permitted' }],
    });
  });
});
