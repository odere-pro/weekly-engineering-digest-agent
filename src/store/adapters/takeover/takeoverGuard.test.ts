import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { acquireTakeoverGuard, GUARD_SUFFIX, guardPathOf } from './takeoverGuard';
import type { LockFile, OwnLock } from '../lockState/lockFile';
import { isLockHeldError } from '../lockState/lockHeldError';
import { TAKEOVER_GUARD_MAX_AGE_MS } from '../lockState/lockTimings';
import { noopLogger, type Logger } from '../../../shared/telemetry';

const NOW = '2026-01-05T08:00:00.000Z';
const HOST = 'this-container';
const OTHER_HOST = 'other-container';

const mine: OwnLock = {
  pid: process.pid,
  runId: '2026-W42',
  startedAt: NOW,
  hostname: HOST,
  token: 'my-token',
  heartbeatAt: NOW,
};

/** A guard as a run on another machine writes it. */
const remoteGuard = (overrides: Partial<LockFile> = {}): LockFile => ({
  pid: 1,
  runId: '2026-W43',
  startedAt: NOW,
  hostname: OTHER_HOST,
  token: 'remote-token',
  ...overrides,
});

let dir: string;
let guardPath: string;
let warn: Mock<Logger['warn']>;
let logger: Logger;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'takeoverguard-'));
  guardPath = guardPathOf(join(dir, 'digest.lock'));
  warn = vi.fn<Logger['warn']>();
  logger = { ...noopLogger, warn, child: () => logger };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const clock = { now: () => new Date(NOW) };

/** The pid of a process that has exited. Spawned once per file: spawning is slow on a busy machine. */
let exitedPid: number | undefined;
function deadPid(): number {
  if (exitedPid !== undefined) return exitedPid;
  const child = spawnSync(process.execPath, ['-e', '']);
  if (child.error) throw child.error;
  exitedPid = child.pid;
  return exitedPid;
}

describe('guardPathOf', () => {
  it('puts the guard next to the lock, with a .takeover suffix', () => {
    expect(GUARD_SUFFIX).toBe('.takeover');
    expect(guardPathOf('/data/digest.lock')).toBe('/data/digest.lock.takeover');
  });
});

describe('acquireTakeoverGuard', () => {
  it('creates the guard with our lock content when there is none', async () => {
    await expect(acquireTakeoverGuard(guardPath, mine, { clock, logger })).resolves.toBe(true);

    expect(JSON.parse(await readFile(guardPath, 'utf8'))).toEqual(mine);
    expect(warn).not.toHaveBeenCalled();
  });

  it('throws the lock-held error while another run holds a live guard', async () => {
    const theirs = remoteGuard({ pid: deadPid() });
    await writeFile(guardPath, JSON.stringify(theirs));

    const attempt = acquireTakeoverGuard(guardPath, mine, { clock, logger });

    await expect(attempt).rejects.toSatisfy(isLockHeldError);
    await expect(attempt).rejects.toThrow(
      `Another run is in progress (pid ${String(theirs.pid)}, host ${OTHER_HOST}, week 2026-W43)`,
    );
    expect(JSON.parse(await readFile(guardPath, 'utf8'))).toEqual(theirs);
  });

  it('removes a guard that is 30 seconds old and says to try again', async () => {
    const startedAt = new Date(Date.parse(NOW) - TAKEOVER_GUARD_MAX_AGE_MS).toISOString();
    await writeFile(guardPath, JSON.stringify(remoteGuard({ startedAt })));

    await expect(acquireTakeoverGuard(guardPath, mine, { clock, logger })).resolves.toBe(false);

    expect(warn).toHaveBeenCalledWith('Removing abandoned lock takeover guard', {
      reason: 'lock is too old',
    });
    expect(await readdir(dir)).toEqual([]);
  });

  it('removes a guard whose process died on this host', async () => {
    await writeFile(guardPath, JSON.stringify(remoteGuard({ hostname: HOST, pid: deadPid() })));

    await expect(acquireTakeoverGuard(guardPath, mine, { clock, logger })).resolves.toBe(false);

    expect(warn).toHaveBeenCalledWith('Removing abandoned lock takeover guard', {
      reason: 'process is not running',
    });
    expect(await readdir(dir)).toEqual([]);
  });

  it('removes a guard that cannot be read', async () => {
    await writeFile(guardPath, 'not json');

    await expect(acquireTakeoverGuard(guardPath, mine, { clock, logger })).resolves.toBe(false);

    expect(warn).toHaveBeenCalledWith('Removing abandoned lock takeover guard', {
      reason: 'lock file is unreadable',
    });
  });

  it('says to try again, silently, when the guard vanishes while we look at it', async () => {
    await writeFile(guardPath, JSON.stringify(remoteGuard()));
    const vanishing = {
      now: (): Date => {
        rmSync(guardPath, { force: true });
        return new Date(NOW);
      },
    };

    await expect(acquireTakeoverGuard(guardPath, mine, { clock: vanishing, logger })).resolves.toBe(
      false,
    );

    expect(warn).not.toHaveBeenCalled();
  });
});
