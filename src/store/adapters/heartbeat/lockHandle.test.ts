import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createLockHandle } from './lockHandle';
import type { HeartbeatOptions } from './heartbeat';
import { createLockFile, type LockFile, type OwnLock } from '../lockState/lockFile';
import type { RunLock } from '../../RunStore';
import { noopLogger, type Logger } from '../../../shared/telemetry';

const NOW = '2026-01-05T08:00:00.000Z';
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const FAST_BEAT_MS = 15;

const mine: OwnLock = {
  pid: process.pid,
  runId: '2026-W42',
  startedAt: NOW,
  hostname: 'this-container',
  token: 'my-token',
  heartbeatAt: NOW,
};
const theirs: LockFile = {
  pid: 1,
  runId: '2026-W41',
  startedAt: NOW,
  hostname: 'other-container',
  token: 'remote-token',
  heartbeatAt: NOW,
};

let dir: string;
let lockPath: string;
let nowMs: number;
let handles: RunLock[];
let warn: Mock<Logger['warn']>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lockhandle-'));
  lockPath = join(dir, 'digest.lock');
  nowMs = Date.parse(NOW);
  handles = [];
  warn = vi.fn<Logger['warn']>();
  await createLockFile(lockPath, mine);
});

afterEach(async () => {
  await chmod(dir, 0o700);
  await Promise.all(handles.map((handle) => handle.release()));
  await rm(dir, { recursive: true, force: true });
});

function handleFor(overrides: Partial<HeartbeatOptions> = {}): RunLock {
  const handle = createLockHandle(lockPath, mine, {
    clock: { now: () => new Date(nowMs) },
    logger: { ...noopLogger, warn },
    heartbeatIntervalMs: HOUR_MS,
    ...overrides,
  });
  handles.push(handle);
  return handle;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('release', () => {
  it('removes the lock file and nothing else', async () => {
    const handle = handleFor();

    await handle.release();

    expect(await readdir(dir)).toEqual([]);
  });

  it('is harmless the second time', async () => {
    const handle = handleFor();

    await handle.release();

    await expect(handle.release()).resolves.toBeUndefined();
  });

  it('leaves the file alone when another run took the lock over', async () => {
    const handle = handleFor();
    await writeFile(lockPath, JSON.stringify(theirs));

    await handle.release();

    expect(JSON.parse(await readFile(lockPath, 'utf8'))).toEqual(theirs);
  });

  it('does not fail when the file is already gone', async () => {
    const handle = handleFor();
    await rm(lockPath);

    await expect(handle.release()).resolves.toBeUndefined();
  });

  it('does not remove a lock taken after the first release, when released again', async () => {
    const handle = handleFor();
    await handle.release();
    await writeFile(lockPath, JSON.stringify(theirs));

    await handle.release();

    expect(JSON.parse(await readFile(lockPath, 'utf8'))).toEqual(theirs);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'can be retried when removing the file fails',
    async () => {
      const handle = handleFor();
      await chmod(dir, 0o500);

      await expect(handle.release()).rejects.toThrow();
      await chmod(dir, 0o700);

      await handle.release();
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );
});

describe('the heartbeat it starts', () => {
  it('beats while the lock is held', async () => {
    handleFor({ heartbeatIntervalMs: FAST_BEAT_MS });

    nowMs += MINUTE_MS;

    await vi.waitFor(
      async () => {
        const lock = JSON.parse(await readFile(lockPath, 'utf8')) as LockFile;
        expect(lock.heartbeatAt).toBe(new Date(nowMs).toISOString());
      },
      { timeout: 3000 },
    );
  });

  it('stops on release and does not bring the file back', async () => {
    const handle = handleFor({ heartbeatIntervalMs: FAST_BEAT_MS });
    await handle.release();

    await sleep(FAST_BEAT_MS * 6);

    expect(await readdir(dir)).toEqual([]);
    // A heartbeat left running would find the file gone and say so.
    expect(warn).not.toHaveBeenCalled();
  });

  it('is waited for on release, so a beat in flight leaves no file behind', async () => {
    const handle = handleFor({ heartbeatIntervalMs: 1 });
    await sleep(20);

    await handle.release();
    await sleep(20);

    expect(await readdir(dir)).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });
});
