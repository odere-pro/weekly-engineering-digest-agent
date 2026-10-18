import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { hostname as osHostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  acquireRunLock,
  LOCK_HEARTBEAT_INTERVAL_MS,
  LOCK_HEARTBEAT_TIMEOUT_MS,
  LOCK_MAX_AGE_MS,
  ORPHANED_TEMP_MAX_AGE_MS,
  TAKEOVER_GUARD_MAX_AGE_MS,
  type AcquireLockOptions,
} from './runLock';
import type * as Os from 'node:os';
import type * as AtomicFile from './atomicFile';
import type { RunLock } from '../RunStore';
import { DigestError } from '../../shared/errors';
import { noopLogger, type Logger } from '../../shared/telemetry';

// Heartbeat writes go through writeFileAtomic and the temp file sweep through
// removeStaleTempFiles; a test can make either fail.
const atomic = vi.hoisted(() => ({ failWrites: false, failSweep: false, stuckFile: false }));
vi.mock('./atomicFile', async (importOriginal) => {
  const actual = await importOriginal<typeof AtomicFile>();
  return {
    ...actual,
    writeFileAtomic: (path: string, content: string) =>
      atomic.failWrites
        ? Promise.reject(new Error('disk full'))
        : actual.writeFileAtomic(path, content),
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

// The machine name is read once per lock; a test can blank it.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof Os>();
  return { ...actual, hostname: vi.fn(actual.hostname) };
});

// Long ago, so that the real modification time of a temp file made while a test runs (a heartbeat
// in flight, a second acquire) always lies in the future of this clock, and the sweep keeps it.
const NOW = '2026-01-05T08:00:00.000Z';
const SECOND_MS = 1000;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const HOST = 'this-container';
const OTHER_HOST = 'other-container';
const NAMESPACE = 'pid:[4026532001]';
const OTHER_NAMESPACE = 'pid:[4026532002]';
/** Short enough to see several beats in a test, long enough not to starve the event loop. */
const FAST_BEAT_MS = 15;
const NO_BEAT_MS = HOUR_MS;

let dir: string;
let lockPath: string;
let guardPath: string;
let nowMs = Date.parse(NOW);
let warn: Mock<Logger['warn']>;
let logger: Logger;
let held: RunLock[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'runlock-'));
  lockPath = join(dir, 'digest.lock');
  guardPath = `${lockPath}.takeover`;
  nowMs = Date.parse(NOW);
  atomic.failWrites = false;
  atomic.failSweep = false;
  atomic.stuckFile = false;
  warn = vi.fn<Logger['warn']>();
  logger = { ...noopLogger, warn, child: () => logger };
  held = [];
});

afterEach(async () => {
  await Promise.all(held.map((lock) => lock.release()));
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

const iso = (offsetMs = 0): string => new Date(nowMs + offsetMs).toISOString();

async function acquire(overrides: Partial<AcquireLockOptions> = {}): Promise<RunLock> {
  const lock = await acquireRunLock({
    lockPath,
    runId: '2026-W42',
    clock: { now: () => new Date(nowMs) },
    logger,
    hostname: HOST,
    pidNamespace: NAMESPACE,
    heartbeatIntervalMs: NO_BEAT_MS,
    ...overrides,
  });
  held.push(lock);
  return lock;
}

function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '']);
  if (child.error) throw child.error;
  return child.pid;
}

interface LockContent {
  pid: number;
  runId: string;
  startedAt: string;
  hostname?: string;
  token?: string;
  pidNamespace?: string;
  heartbeatAt?: string;
}

async function readLock(path = lockPath): Promise<LockContent> {
  return JSON.parse(await readFile(path, 'utf8')) as LockContent;
}

async function writeLock(content: unknown, path = lockPath): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content));
}

/** A lock as a current run on another machine writes it. */
const remoteLock = (overrides: Partial<LockContent> = {}): LockContent => ({
  pid: 1,
  runId: '2026-W41',
  startedAt: iso(),
  hostname: OTHER_HOST,
  token: 'remote-token',
  heartbeatAt: iso(),
  ...overrides,
});

function expectStaleWarning(reason: string | RegExp): void {
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith(
    'Taking over stale run lock',
    expect.objectContaining({
      reason: typeof reason === 'string' ? reason : (expect.stringMatching(reason) as string),
    }),
  );
}

describe('the lock file', () => {
  it('records pid, host, a per-process token and the first heartbeat', async () => {
    await acquire();

    expect(await readLock()).toEqual({
      pid: process.pid,
      runId: '2026-W42',
      startedAt: NOW,
      hostname: HOST,
      token: expect.stringMatching(/^[0-9a-f-]{36}$/) as string,
      pidNamespace: NAMESPACE,
      heartbeatAt: NOW,
    });
  });

  it('names the PID namespace from /proc by default, where there is one', async () => {
    const expected = await readlink('/proc/self/ns/pid').catch(() => undefined);
    const lock = await acquireRunLock({
      lockPath,
      runId: '2026-W42',
      clock: { now: () => new Date(NOW) },
      logger,
      hostname: HOST,
    });
    held.push(lock);

    expect((await readLock()).pidNamespace).toBe(expected);
  });

  it('falls back to a name when the machine reports an empty hostname', async () => {
    vi.mocked(osHostname).mockReturnValueOnce('');
    const lock = await acquireRunLock({
      lockPath,
      runId: '2026-W42',
      clock: { now: () => new Date(NOW) },
      logger,
    });
    held.push(lock);

    expect((await readLock()).hostname).toBe('unknown');
    await expect(acquire({ hostname: 'unknown', runId: '2026-W43' })).rejects.toThrow(DigestError);
  });

  it('names this machine with os.hostname() by default', async () => {
    const lock = await acquireRunLock({
      lockPath,
      runId: '2026-W42',
      clock: { now: () => new Date(NOW) },
      logger,
    });
    held.push(lock);

    expect((await readLock()).hostname).toBe(osHostname());
  });

  it('uses one token for every lock this process takes', async () => {
    const first = await acquire();
    const { token } = await readLock();
    await first.release();

    await acquire({ runId: '2026-W43' });

    expect((await readLock()).token).toBe(token);
  });

  it('is removed on release, and releasing twice is harmless', async () => {
    const lock = await acquire();

    await lock.release();
    await lock.release();

    expect(await readdir(dir)).toEqual([]);
  });

  it('creates the folder when it does not exist yet', async () => {
    lockPath = join(dir, 'nested', 'digest.lock');

    await acquire();

    await expect(stat(lockPath)).resolves.toBeDefined();
  });

  it('is left alone on release when another run took it over', async () => {
    const lock = await acquire();
    await writeLock(remoteLock());

    await lock.release();

    expect((await readLock()).hostname).toBe(OTHER_HOST);
  });
});

describe('a held lock', () => {
  it('refuses a second run in the same process', async () => {
    await acquire();

    const second = acquire({ runId: '2026-W43' });

    await expect(second).rejects.toThrow(DigestError);
    await expect(second).rejects.toThrow(
      `Another run is in progress (pid ${String(process.pid)}, host ${HOST}, week 2026-W42)`,
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('lets exactly one of two concurrent acquires win', async () => {
    const results = await Promise.allSettled([acquire(), acquire()]);

    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
  });

  it('is live on another host with a fresh heartbeat, whatever its pid says', async () => {
    const theirs = remoteLock({ pid: deadPid() });
    await writeLock(theirs);

    await expect(acquire()).rejects.toThrow(
      `Another run is in progress (pid ${String(theirs.pid)}, host ${OTHER_HOST}, week 2026-W41)`,
    );
    expect(warn).not.toHaveBeenCalled();
    expect((await readLock()).hostname).toBe(OTHER_HOST);
  });

  it('is live on another host with a pid this host cannot see, such as PID 1 in a container', async () => {
    await writeLock(remoteLock({ pid: 1 }));

    await expect(acquire()).rejects.toThrow(/host other-container/);
  });

  it('stays live until its heartbeat is a full timeout old', async () => {
    await writeLock(remoteLock({ heartbeatAt: iso(-(LOCK_HEARTBEAT_TIMEOUT_MS - SECOND_MS)) }));

    await expect(acquire()).rejects.toThrow(DigestError);
  });

  it('stays live however long it runs, while it keeps its heartbeat', async () => {
    await writeLock(remoteLock({ startedAt: iso(-(LOCK_MAX_AGE_MS + HOUR_MS)) }));

    await expect(acquire()).rejects.toThrow(DigestError);
  });

  it('treats a heartbeat a little in the future (clock skew) as fresh', async () => {
    await writeLock(remoteLock({ heartbeatAt: iso(2 * MINUTE_MS) }));

    await expect(acquire()).rejects.toThrow(DigestError);
  });

  it('is live on this hostname in another PID namespace, whatever its pid says', async () => {
    // Two containers that pin the same hostname still have separate pids.
    await writeLock(remoteLock({ hostname: HOST, pidNamespace: OTHER_NAMESPACE, pid: deadPid() }));

    await expect(acquire()).rejects.toThrow(DigestError);
    expect(warn).not.toHaveBeenCalled();
  });

  it('is live with our pid but another token when it lives in another PID namespace', async () => {
    await writeLock(
      remoteLock({ hostname: HOST, pidNamespace: OTHER_NAMESPACE, pid: process.pid }),
    );

    await expect(acquire()).rejects.toThrow(DigestError);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('a stale lock', () => {
  it('is taken over when its heartbeat is a full timeout old, on any host', async () => {
    await writeLock(remoteLock({ heartbeatAt: iso(-LOCK_HEARTBEAT_TIMEOUT_MS) }));

    await acquire();

    expectStaleWarning('heartbeat is stale');
    expect((await readLock()).hostname).toBe(HOST);
    expect(await readdir(dir)).toEqual(['digest.lock']);
  });

  it('is taken over when its pid is dead on this host', async () => {
    await writeLock(remoteLock({ hostname: HOST, pid: deadPid() }));

    await acquire();

    expectStaleWarning('process is not running');
    expect((await readLock()).runId).toBe('2026-W42');
  });

  it('is taken over when its pid is dead in our PID namespace', async () => {
    await writeLock(remoteLock({ hostname: HOST, pidNamespace: NAMESPACE, pid: deadPid() }));

    await acquire();

    expectStaleWarning('process is not running');
  });

  it('is taken over when its heartbeat is a full timeout in the future (a clock that was ahead)', async () => {
    await writeLock(remoteLock({ heartbeatAt: iso(LOCK_HEARTBEAT_TIMEOUT_MS) }));

    await acquire();

    expectStaleWarning('heartbeat is stale');
  });

  it('is taken over when it has our pid and host but another token (a previous incarnation)', async () => {
    await writeLock(remoteLock({ hostname: HOST, pid: process.pid, token: 'before-the-restart' }));

    await acquire();

    expectStaleWarning(/previous process/);
    expect((await readLock()).token).not.toBe('before-the-restart');
  });

  it('is not taken over on pid alone when the token is ours', async () => {
    const first = await acquire();
    const { token } = await readLock();
    await first.release();
    await writeLock(remoteLock({ hostname: HOST, pid: process.pid, token }));

    await expect(acquire()).rejects.toThrow(DigestError);
  });

  it('is taken over when it cannot be read', async () => {
    await writeLock('not json');

    await acquire();

    expectStaleWarning('lock file is unreadable');
  });

  it.each([
    ['empty', ''],
    ['missing fields', JSON.stringify({ pid: process.pid })],
    ['pid 0', JSON.stringify({ pid: 0, runId: '2026-W41', startedAt: NOW })],
    ['a heartbeat that is not a date', JSON.stringify(remoteLock({ heartbeatAt: 'yesterday' }))],
  ])('is taken over when it is %s', async (_label, content) => {
    await writeLock(content);

    await acquire();

    expectStaleWarning('lock file is unreadable');
  });

  it('is judged by its age alone when it has a host but no heartbeat', async () => {
    const { heartbeatAt: _beat, ...withoutHeartbeat } = remoteLock();
    await writeLock({ ...withoutHeartbeat, startedAt: iso(-(LOCK_MAX_AGE_MS - SECOND_MS)) });
    await expect(acquire()).rejects.toThrow(DigestError);

    await writeLock({ ...withoutHeartbeat, startedAt: iso(-LOCK_MAX_AGE_MS) });
    await acquire();

    expectStaleWarning('lock is too old');
  });
});

describe('a legacy lock (pid, run and start time only)', () => {
  const legacy = (overrides: Partial<LockContent> = {}): LockContent => ({
    pid: process.pid,
    runId: '2026-W41',
    startedAt: NOW,
    ...overrides,
  });

  it('is taken over when its pid is dead, as it is for any lock from this host', async () => {
    await writeLock(legacy({ pid: deadPid() }));

    await acquire();

    expectStaleWarning('process is not running');
    expect(await readdir(dir)).toEqual(['digest.lock']);
  });

  it('is live while its pid runs and it is younger than 6 hours', async () => {
    await writeLock(legacy({ startedAt: iso(-(LOCK_MAX_AGE_MS - SECOND_MS)) }));

    await expect(acquire()).rejects.toThrow(`pid ${String(process.pid)}, week 2026-W41)`);
    expect(warn).not.toHaveBeenCalled();
  });

  it('is taken over at 6 hours even if its pid runs', async () => {
    await writeLock(legacy({ startedAt: iso(-LOCK_MAX_AGE_MS) }));

    await acquire();

    expectStaleWarning('lock is too old');
  });

  it('is live when its pid belongs to another user (EPERM)', async () => {
    await writeLock(legacy({ pid: 4242 }));
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    });

    await expect(acquire()).rejects.toThrow('Another run is in progress (pid 4242, week 2026-W41)');
  });
});

describe('the takeover guard', () => {
  const staleLock = (): LockContent => remoteLock({ hostname: HOST, pid: deadPid() });

  it('keeps a fresh guard from another host, whatever its pid says', async () => {
    const stale = staleLock();
    await writeLock(stale);
    await writeLock(remoteLock({ pid: deadPid(), runId: '2026-W43' }), guardPath);

    await expect(acquire()).rejects.toThrow(
      /Another run is in progress \(pid \d+, host other-container, week 2026-W43\)/,
    );
    expect(await readLock()).toEqual(stale);
  });

  it('removes a guard that is 30 seconds old, then takes over', async () => {
    await writeLock(staleLock());
    await writeLock(remoteLock({ startedAt: iso(-TAKEOVER_GUARD_MAX_AGE_MS) }), guardPath);

    await acquire();

    expect(warn).toHaveBeenCalledWith(
      'Removing abandoned lock takeover guard',
      expect.objectContaining({ reason: 'lock is too old' }),
    );
    expect(await readdir(dir)).toEqual(['digest.lock']);
  });

  it('removes a guard whose process died on this host', async () => {
    await writeLock(staleLock());
    await writeLock(remoteLock({ hostname: HOST, pid: deadPid() }), guardPath);

    await acquire();

    expect(warn).toHaveBeenCalledWith(
      'Removing abandoned lock takeover guard',
      expect.objectContaining({ reason: 'process is not running' }),
    );
  });

  it('is gone once the takeover is done', async () => {
    await writeLock(staleLock());

    await acquire();

    expect(await readdir(dir)).toEqual(['digest.lock']);
  });
});

describe('the heartbeat', () => {
  async function heartbeatAt(): Promise<string | undefined> {
    return (await readLock()).heartbeatAt;
  }

  it('refreshes heartbeatAt while the lock is held, and nothing else', async () => {
    await acquire({ heartbeatIntervalMs: FAST_BEAT_MS });
    const before = await readLock();

    nowMs += MINUTE_MS;
    await vi.waitFor(
      async () => {
        expect(await heartbeatAt()).toBe(iso());
      },
      { timeout: 3000 },
    );

    expect(await readLock()).toEqual({ ...before, heartbeatAt: iso() });
  });

  it('keeps a long run live: a contender sees a fresh heartbeat after the timeout has passed', async () => {
    await acquire({ heartbeatIntervalMs: FAST_BEAT_MS });

    nowMs += LOCK_HEARTBEAT_TIMEOUT_MS + MINUTE_MS;
    await vi.waitFor(
      async () => {
        expect(await heartbeatAt()).toBe(iso());
      },
      { timeout: 3000 },
    );

    await expect(acquire({ hostname: OTHER_HOST })).rejects.toThrow(DigestError);
    expect(warn).not.toHaveBeenCalled();
  });

  it('stops on release and does not bring the file back', async () => {
    const lock = await acquire({ heartbeatIntervalMs: FAST_BEAT_MS });
    await lock.release();

    await new Promise((resolve) => setTimeout(resolve, FAST_BEAT_MS * 6));

    expect(await readdir(dir)).toEqual([]);
  });

  it('waits for a beat in flight, so release leaves no file behind', async () => {
    const lock = await acquire({ heartbeatIntervalMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));

    await lock.release();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await readdir(dir)).toEqual([]);
  });

  it('does not keep the process alive', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    await acquire({ heartbeatIntervalMs: FAST_BEAT_MS });

    const timer = setIntervalSpy.mock.results[0]?.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
  });

  it('beats every 60 seconds by default', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    await acquireRunLock({
      lockPath,
      runId: '2026-W42',
      clock: { now: () => new Date(nowMs) },
      logger,
      hostname: HOST,
    }).then((lock) => held.push(lock));

    expect(LOCK_HEARTBEAT_INTERVAL_MS).toBe(60_000);
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), LOCK_HEARTBEAT_INTERVAL_MS);
  });

  it('beats well inside the timeout', () => {
    expect(LOCK_HEARTBEAT_TIMEOUT_MS).toBe(5 * MINUTE_MS);
    expect(LOCK_HEARTBEAT_INTERVAL_MS * 3).toBeLessThan(LOCK_HEARTBEAT_TIMEOUT_MS);
  });

  it('does not overwrite a lock another run took over, and stops beating', async () => {
    await acquire({ heartbeatIntervalMs: FAST_BEAT_MS });
    const theirs = remoteLock();
    await writeLock(theirs);

    await vi.waitFor(
      () => {
        expect(warn).toHaveBeenCalledWith(
          'Run lock is no longer ours (taken over or removed); its heartbeat stops',
          expect.objectContaining({ runId: '2026-W42' }),
        );
      },
      { timeout: 3000 },
    );
    nowMs += MINUTE_MS;
    await new Promise((resolve) => setTimeout(resolve, FAST_BEAT_MS * 4));

    expect(await readLock()).toEqual(theirs);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does not bring back a lock file that was removed, and stops beating', async () => {
    await acquire({ heartbeatIntervalMs: FAST_BEAT_MS });
    await rm(lockPath);

    await vi.waitFor(
      () => {
        expect(warn).toHaveBeenCalledWith(
          'Run lock is no longer ours (taken over or removed); its heartbeat stops',
          expect.objectContaining({ runId: '2026-W42' }),
        );
      },
      { timeout: 3000 },
    );
    await new Promise((resolve) => setTimeout(resolve, FAST_BEAT_MS * 4));

    expect(await readdir(dir)).toEqual([]);
  });

  it('logs a failed beat, keeps the run going and tries again', async () => {
    await acquire({ heartbeatIntervalMs: FAST_BEAT_MS });
    atomic.failWrites = true;

    await vi.waitFor(
      () => {
        expect(warn).toHaveBeenCalledWith(
          'Could not refresh the run lock heartbeat',
          expect.objectContaining({ error: 'disk full' }),
        );
      },
      { timeout: 3000 },
    );

    atomic.failWrites = false;
    nowMs += MINUTE_MS;
    await vi.waitFor(
      async () => {
        expect(await heartbeatAt()).toBe(iso());
      },
      { timeout: 3000 },
    );
  });
});

describe('orphaned temp files', () => {
  const tempName = (base: string, pid = 4242): string =>
    `${base}.${String(pid)}.${randomUUID()}.tmp`;

  /** A file in the lock folder whose last change was `ageMs` before the lock clock's now. */
  async function writeAged(name: string, ageMs: number): Promise<void> {
    await writeFile(join(dir, name), 'x');
    const modified = new Date(nowMs - ageMs);
    await utimes(join(dir, name), modified, modified);
  }

  const names = async (): Promise<string[]> => (await readdir(dir)).sort();

  it('are removed when the lock is taken, once they are 10 minutes old', async () => {
    expect(ORPHANED_TEMP_MAX_AGE_MS).toBe(10 * MINUTE_MS);
    const orphan = tempName('digest.lock');
    await writeAged(orphan, ORPHANED_TEMP_MAX_AGE_MS);

    await acquire();

    expect(await names()).toEqual(['digest.lock']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('Removed orphaned run lock temp files', { files: [orphan] });
  });

  it('are kept while younger than 10 minutes, because their writer may be running', async () => {
    const fresh = tempName('digest.lock');
    await writeAged(fresh, ORPHANED_TEMP_MAX_AGE_MS - SECOND_MS);

    await acquire();

    expect(await names()).toEqual(['digest.lock', fresh].sort());
    expect(warn).not.toHaveBeenCalled();
  });

  it('are removed for the takeover guard as well', async () => {
    const orphan = tempName('digest.lock.takeover');
    await writeAged(orphan, 3 * ORPHANED_TEMP_MAX_AGE_MS);

    await acquire();

    expect(await names()).toEqual(['digest.lock']);
  });

  it('leave foreign files alone, old as they are', async () => {
    const foreign = [
      'notes.tmp',
      'digest.lock.bak',
      tempName('digest.json'),
      tempName('other.lock'),
    ];
    for (const name of foreign) await writeAged(name, 24 * HOUR_MS);

    await acquire();

    expect(await names()).toEqual(['digest.lock', ...foreign].sort());
    expect(warn).not.toHaveBeenCalled();
  });

  it('are also removed when a live run holds the lock', async () => {
    await acquire();
    const orphan = tempName('digest.lock');
    await writeAged(orphan, 2 * ORPHANED_TEMP_MAX_AGE_MS);

    await expect(acquire({ runId: '2026-W43' })).rejects.toThrow(DigestError);

    expect(await names()).toEqual(['digest.lock']);
  });

  it('are removed before a stale lock is taken over, next to the takeover warning', async () => {
    await writeLock(remoteLock({ heartbeatAt: iso(-LOCK_HEARTBEAT_TIMEOUT_MS) }));
    const orphan = tempName('digest.lock');
    await writeAged(orphan, 2 * ORPHANED_TEMP_MAX_AGE_MS);

    await acquire();

    expect(await names()).toEqual(['digest.lock']);
    expect(warn).toHaveBeenCalledWith('Removed orphaned run lock temp files', { files: [orphan] });
    expect(warn).toHaveBeenCalledWith('Taking over stale run lock', expect.anything());
  });

  it('are never the reason a run cannot start: a failed sweep is logged and the lock is taken', async () => {
    atomic.failSweep = true;

    await acquire();

    expect(warn).toHaveBeenCalledWith('Could not sweep orphaned run lock temp files', {
      error: 'folder unreadable',
    });
    expect((await readLock()).runId).toBe('2026-W42');
  });

  it('are reported when one cannot be removed, and the lock is still taken', async () => {
    atomic.stuckFile = true;

    await acquire();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('Could not remove orphaned run lock temp files', {
      failed: [{ name: 'digest.lock.1.stuck.tmp', error: 'operation not permitted' }],
    });
    expect((await readLock()).runId).toBe('2026-W42');
  });
});
