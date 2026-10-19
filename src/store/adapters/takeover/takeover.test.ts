import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { takeOverStaleLock } from './takeover';
import { guardPathOf } from './takeoverGuard';
import type { LockFile, OwnLock } from '../lockState/lockFile';
import { isLockHeldError } from '../../lockHeld';
import { LOCK_HEARTBEAT_TIMEOUT_MS } from '../lockState/lockTimings';
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

const remote = (overrides: Partial<LockFile> = {}): LockFile => ({
  pid: 1,
  runId: '2026-W41',
  startedAt: NOW,
  hostname: OTHER_HOST,
  token: 'remote-token',
  heartbeatAt: NOW,
  ...overrides,
});

let dir: string;
let lockPath: string;
let guardPath: string;
let warn: Mock<Logger['warn']>;
let logger: Logger;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'takeover-'));
  lockPath = join(dir, 'digest.lock');
  guardPath = guardPathOf(lockPath);
  warn = vi.fn<Logger['warn']>();
  logger = { ...noopLogger, warn, child: () => logger };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const clock = { now: () => new Date(NOW) };
const options = (): { lockPath: string; clock: typeof clock; logger: Logger } => ({
  lockPath,
  clock,
  logger,
});
const staleLock = (): LockFile =>
  remote({ heartbeatAt: new Date(Date.parse(NOW) - LOCK_HEARTBEAT_TIMEOUT_MS).toISOString() });

/** The pid of a process that has exited. Spawned once per file: spawning is slow on a busy machine. */
let exitedPid: number | undefined;
function deadPid(): number {
  if (exitedPid !== undefined) return exitedPid;
  const child = spawnSync(process.execPath, ['-e', '']);
  if (child.error) throw child.error;
  exitedPid = child.pid;
  return exitedPid;
}

const readLock = async (): Promise<unknown> => JSON.parse(await readFile(lockPath, 'utf8'));

describe('takeOverStaleLock', () => {
  it('replaces a stale lock with ours, warns, and leaves no guard behind', async () => {
    const previous = staleLock();
    await writeFile(lockPath, JSON.stringify(previous));

    await expect(takeOverStaleLock(mine, options())).resolves.toBe(true);

    expect(await readLock()).toEqual(mine);
    expect(await readdir(dir)).toEqual(['digest.lock']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('Taking over stale run lock', {
      reason: 'heartbeat is stale',
      previous,
    });
  });

  it('replaces a lock that cannot be read, naming no previous holder', async () => {
    await writeFile(lockPath, 'not json');

    await expect(takeOverStaleLock(mine, options())).resolves.toBe(true);

    expect(warn).toHaveBeenCalledWith('Taking over stale run lock', {
      reason: 'lock file is unreadable',
      previous: undefined,
    });
  });

  it('creates our lock without a warning when the lock vanished meanwhile', async () => {
    await expect(takeOverStaleLock(mine, options())).resolves.toBe(true);

    expect(await readLock()).toEqual(mine);
    expect(warn).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual(['digest.lock']);
  });

  it('gives way to a live lock that replaced the stale one, and removes its guard', async () => {
    await writeFile(lockPath, JSON.stringify(remote()));

    const attempt = takeOverStaleLock(mine, options());

    await expect(attempt).rejects.toSatisfy(isLockHeldError);
    expect(await readLock()).toEqual(remote());
    expect(await readdir(dir)).toEqual(['digest.lock']);
  });

  it('gives way to a run that holds a live guard, and touches nothing', async () => {
    const previous = staleLock();
    await writeFile(lockPath, JSON.stringify(previous));
    const theirGuard = remote({ pid: deadPid(), runId: '2026-W43' });
    await writeFile(guardPath, JSON.stringify(theirGuard));

    await expect(takeOverStaleLock(mine, options())).rejects.toSatisfy(isLockHeldError);

    expect(await readLock()).toEqual(previous);
    expect(JSON.parse(await readFile(guardPath, 'utf8'))).toEqual(theirGuard);
  });

  it('clears an abandoned guard and asks the caller to try again', async () => {
    const previous = staleLock();
    await writeFile(lockPath, JSON.stringify(previous));
    await writeFile(guardPath, JSON.stringify(remote({ hostname: HOST, pid: deadPid() })));

    await expect(takeOverStaleLock(mine, options())).resolves.toBe(false);

    expect(await readLock()).toEqual(previous);
    expect(await readdir(dir)).toEqual(['digest.lock']);
  });

  it('backs off without touching anything when its guard was replaced under it', async () => {
    const previous = staleLock();
    await writeFile(lockPath, JSON.stringify(previous));
    const theirGuard = remote({ pid: process.pid, runId: '2026-W43' });
    // The first clock reading happens while we hold the guard and look at the lock again:
    // another run breaks our guard and puts its own in place at exactly that moment.
    const replacing = {
      now: (): Date => {
        writeFileSync(guardPath, JSON.stringify(theirGuard));
        return new Date(NOW);
      },
    };

    await expect(takeOverStaleLock(mine, { lockPath, clock: replacing, logger })).resolves.toBe(
      false,
    );

    expect(await readLock()).toEqual(previous);
    expect(JSON.parse(await readFile(guardPath, 'utf8'))).toEqual(theirGuard);
    expect(warn).not.toHaveBeenCalled();
  });

  it('leaves a guard that is not ours in place after a failed takeover', async () => {
    await writeFile(lockPath, JSON.stringify(remote()));
    const replacing = {
      now: (): Date => {
        writeFileSync(guardPath, JSON.stringify(remote({ runId: '2026-W43', pid: process.pid })));
        return new Date(NOW);
      },
    };

    await expect(takeOverStaleLock(mine, { lockPath, clock: replacing, logger })).rejects.toSatisfy(
      isLockHeldError,
    );

    expect((await readdir(dir)).sort()).toEqual(['digest.lock', 'digest.lock.takeover']);
  });
});
