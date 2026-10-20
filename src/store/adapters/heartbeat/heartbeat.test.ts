import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { startHeartbeat, type Heartbeat, type HeartbeatOptions } from './heartbeat';
import { createLockFile, type LockFile, type OwnLock } from '../lockState/lockFile';
import { LOCK_HEARTBEAT_INTERVAL_MS } from '../lockState/lockTimings';
import { LOCK_LOST_MESSAGE } from '../../lockLost';
import { errorMessage } from '../../../shared/errors';
import { noopLogger, type Logger } from '../../../shared/telemetry';
import type * as AtomicFile from '../../../shared/atomicFile';

// Heartbeat writes go through writeFileAtomic; a test can make them fail or wait.
const atomic = vi.hoisted(() => ({
  failWrites: false,
  writes: 0,
  gate: undefined as Promise<void> | undefined,
}));
vi.mock('../../../shared/atomicFile', async (importOriginal) => {
  const actual = await importOriginal<typeof AtomicFile>();
  return {
    ...actual,
    writeFileAtomic: async (path: string, content: string): Promise<void> => {
      atomic.writes += 1;
      if (atomic.failWrites) throw new Error('disk full');
      if (atomic.gate) await atomic.gate;
      await actual.writeFileAtomic(path, content);
    },
  };
});

const NOW = '2026-01-05T08:00:00.000Z';
const MINUTE_MS = 60_000;
/** Short enough to see several beats in a test, long enough not to starve the event loop. */
const FAST_BEAT_MS = 15;
const WAIT = { timeout: 3000 };
const LOST_LOCK_WARNING = 'Run lock is no longer ours (taken over or removed); this run stops';

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
let warn: Mock<Logger['warn']>;
let logger: Logger;
let running: Heartbeat[];
let openGates: (() => void)[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'heartbeat-'));
  lockPath = join(dir, 'digest.lock');
  nowMs = Date.parse(NOW);
  atomic.failWrites = false;
  atomic.writes = 0;
  atomic.gate = undefined;
  warn = vi.fn<Logger['warn']>();
  logger = { ...noopLogger, warn, child: () => logger };
  running = [];
  openGates = [];
  await createLockFile(lockPath, mine);
});

afterEach(async () => {
  // A test that failed before it opened its gate must not leave a beat waiting forever.
  openGates.forEach((open) => {
    open();
  });
  await Promise.all(running.map((heartbeat) => heartbeat.stop()));
  await rm(dir, { recursive: true, force: true });
});

const iso = (offsetMs = 0): string => new Date(nowMs + offsetMs).toISOString();
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function begin(overrides: Partial<HeartbeatOptions> = {}): Heartbeat {
  const heartbeat = startHeartbeat(lockPath, mine, {
    clock: { now: () => new Date(nowMs) },
    logger,
    heartbeatIntervalMs: FAST_BEAT_MS,
    ...overrides,
  });
  running.push(heartbeat);
  return heartbeat;
}

async function readLock(): Promise<LockFile> {
  return JSON.parse(await readFile(lockPath, 'utf8')) as LockFile;
}

async function waitForHeartbeat(expected: string): Promise<void> {
  await vi.waitFor(async () => {
    expect((await readLock()).heartbeatAt).toBe(expected);
  }, WAIT);
}

function waitForLostLockWarning(): Promise<void> {
  return vi.waitFor(() => {
    expect(warn).toHaveBeenCalledWith(
      LOST_LOCK_WARNING,
      expect.objectContaining({ runId: '2026-W42' }),
    );
  }, WAIT);
}

function deferred(): { promise: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  openGates.push(open);
  return { promise, open };
}

describe('startHeartbeat while the lock is ours', () => {
  it('refreshes heartbeatAt and nothing else', async () => {
    begin();

    nowMs += MINUTE_MS;
    await waitForHeartbeat(iso());

    expect(await readLock()).toEqual({ ...mine, heartbeatAt: iso() });
  });

  it('keeps beating beat after beat', async () => {
    begin();

    nowMs += MINUTE_MS;
    await waitForHeartbeat(iso());
    nowMs += MINUTE_MS;
    await waitForHeartbeat(iso());

    expect(atomic.writes).toBeGreaterThanOrEqual(2);
  });

  it('never fires lost', async () => {
    const heartbeat = begin();

    nowMs += MINUTE_MS;
    await waitForHeartbeat(iso());

    expect(heartbeat.lost.aborted).toBe(false);
  });

  it('does not keep the process alive', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    begin();

    const timer = setIntervalSpy.mock.results[0]?.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
  });

  it('beats every 60 seconds unless told otherwise', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    begin({ heartbeatIntervalMs: undefined });

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), LOCK_HEARTBEAT_INTERVAL_MS);
  });

  it('skips beats while one is still being written, instead of queueing them', async () => {
    const gate = deferred();
    atomic.gate = gate.promise;
    begin({ heartbeatIntervalMs: 5 });

    await vi.waitFor(() => {
      expect(atomic.writes).toBe(1);
    }, WAIT);
    await sleep(60);
    expect(atomic.writes).toBe(1);

    gate.open();
    await vi.waitFor(() => {
      expect(atomic.writes).toBeGreaterThan(1);
    }, WAIT);
  });
});

describe('stop', () => {
  it('ends the beats', async () => {
    const heartbeat = begin();
    await heartbeat.stop();
    const writes = atomic.writes;

    nowMs += MINUTE_MS;
    await sleep(FAST_BEAT_MS * 6);

    expect(atomic.writes).toBe(writes);
    expect((await readLock()).heartbeatAt).not.toBe(iso());
  });

  it('does not bring back a lock file that was removed afterwards', async () => {
    const heartbeat = begin();
    await heartbeat.stop();

    await rm(lockPath);
    await sleep(FAST_BEAT_MS * 6);

    expect(await readdir(dir)).toEqual([]);
    // A timer left running would find the file gone and say so.
    expect(warn).not.toHaveBeenCalled();
  });

  it('waits for a beat in flight, so nothing is written after it returns', async () => {
    const gate = deferred();
    atomic.gate = gate.promise;
    const heartbeat = begin();
    await vi.waitFor(() => {
      expect(atomic.writes).toBe(1);
    }, WAIT);

    let stopped = false;
    const stopping = heartbeat.stop().then(() => {
      stopped = true;
    });
    await sleep(30);
    expect(stopped).toBe(false);

    gate.open();
    await stopping;
    expect(stopped).toBe(true);
  });

  it('can be called twice', async () => {
    const heartbeat = begin();

    await heartbeat.stop();

    await expect(heartbeat.stop()).resolves.toBeUndefined();
  });

  it('does not fire lost: a release is not a loss', async () => {
    const heartbeat = begin();

    await heartbeat.stop();
    await rm(lockPath);
    await sleep(FAST_BEAT_MS * 6);

    expect(heartbeat.lost.aborted).toBe(false);
  });
});

describe('when the lock stops being ours', () => {
  // The takeover must happen before the first tick, so the test fires ticks by hand.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires lost, with a reason that names the loss only', async () => {
    const heartbeat = begin();
    await writeFile(lockPath, JSON.stringify(theirs));

    await vi.advanceTimersByTimeAsync(FAST_BEAT_MS);
    await waitForLostLockWarning();

    expect(heartbeat.lost.aborted).toBe(true);
    expect(errorMessage(heartbeat.lost.reason)).toBe(LOCK_LOST_MESSAGE);
  });

  it('fires lost when the lock file was removed, too', async () => {
    const heartbeat = begin();
    await rm(lockPath);

    await vi.advanceTimersByTimeAsync(FAST_BEAT_MS);
    await waitForLostLockWarning();

    expect(heartbeat.lost.aborted).toBe(true);
  });

  it('does not overwrite a lock another run took over, and stops beating', async () => {
    begin();
    await writeFile(lockPath, JSON.stringify(theirs));

    await vi.advanceTimersByTimeAsync(FAST_BEAT_MS);
    await waitForLostLockWarning();
    nowMs += MINUTE_MS;
    await vi.advanceTimersByTimeAsync(FAST_BEAT_MS * 4);
    await sleep(FAST_BEAT_MS);

    expect(await readLock()).toEqual(theirs);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(atomic.writes).toBe(0);
  });

  it('does not bring back a lock file that was removed, and stops beating', async () => {
    begin();
    await rm(lockPath);

    await vi.advanceTimersByTimeAsync(FAST_BEAT_MS);
    await waitForLostLockWarning();
    await vi.advanceTimersByTimeAsync(FAST_BEAT_MS * 4);
    await sleep(FAST_BEAT_MS);

    expect(await readdir(dir)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(atomic.writes).toBe(0);
  });
});

describe('when a beat fails', () => {
  it('logs it, keeps the run going and tries again', async () => {
    const heartbeat = begin();
    atomic.failWrites = true;

    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(
        'Could not refresh the run lock heartbeat',
        expect.objectContaining({ error: 'disk full' }),
      );
    }, WAIT);
    expect(heartbeat.lost.aborted).toBe(false);

    atomic.failWrites = false;
    nowMs += MINUTE_MS;
    await waitForHeartbeat(iso());
  });

  it('does not stop beating for good', async () => {
    begin();
    atomic.failWrites = true;
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalled();
    }, WAIT);
    const failedWrites = atomic.writes;

    await vi.waitFor(() => {
      expect(atomic.writes).toBeGreaterThan(failedWrites);
    }, WAIT);
  });
});
