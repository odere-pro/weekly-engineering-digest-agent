import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createFsRunStore } from './fsRunStore';
import { ExitCode } from '../../domain/schemas';
import type { RunStore } from '../RunStore';
import { DigestError } from '../../shared/errors';
import { fixedClock } from '../../shared/clock';
import { noopLogger, type Logger } from '../../shared/telemetry';

// The run lock as the store hands it out: the same cases `runLock.test.ts` runs on the lock
// itself, here through `acquireLock`, with the run id check and the data folder in front.
const HOUR_MS = 3_600_000;
const NOW = '2026-10-19T08:00:00.000Z';

let root: string;
let dataDir: string;
let warn: Mock<Logger['warn']>;
let logger: Logger;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fsrunstore-lock-'));
  dataDir = join(root, 'data');
  warn = vi.fn<Logger['warn']>();
  logger = { ...noopLogger, warn, child: () => logger };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function makeStore(): RunStore {
  return createFsRunStore({ dataDir, clock: fixedClock(NOW), logger });
}

const lockPath = (): string => join(dataDir, 'digest.lock');
const guardPath = (): string => `${lockPath()}.takeover`;

function expectStaleLockWarning(reason: string): void {
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith(
    'Taking over stale run lock',
    expect.objectContaining({ reason }),
  );
}

async function writeLock(content: unknown): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(lockPath(), typeof content === 'string' ? content : JSON.stringify(content));
}

/** The pid of a process that has exited. Spawned once per file: spawning is slow on a busy machine. */
let exitedPid: number | undefined;
function deadPid(): number {
  if (exitedPid !== undefined) return exitedPid;
  const child = spawnSync(process.execPath, ['-e', '']);
  if (child.error) throw child.error;
  exitedPid = child.pid;
  return exitedPid;
}

describe('acquireLock', () => {
  it('creates digest.lock with pid, runId and startedAt, and release removes it', async () => {
    const store = makeStore();
    const lock = await store.acquireLock('2026-W42');

    const content = JSON.parse(await readFile(lockPath(), 'utf8')) as unknown;
    expect(content).toEqual({
      pid: process.pid,
      runId: '2026-W42',
      startedAt: NOW,
      hostname: hostname(),
      token: expect.any(String) as string,
      heartbeatAt: NOW,
    });

    await lock.release();
    await expect(stat(lockPath())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('throws a DigestError with exit code 1 when a live run holds the lock', async () => {
    const store = makeStore();
    await store.acquireLock('2026-W42');

    const second = store.acquireLock('2026-W43');
    await expect(second).rejects.toThrow(DigestError);
    await expect(second).rejects.toThrow(
      `Another run is in progress (pid ${String(process.pid)}, host ${hostname()}, week 2026-W42)`,
    );
    await expect(second).rejects.toMatchObject({ exitCode: ExitCode.Failed });
  });

  it('lets exactly one of two concurrent acquires win', async () => {
    const store = makeStore();
    const results = await Promise.allSettled([
      store.acquireLock('2026-W42'),
      store.acquireLock('2026-W42'),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
  });

  it('can be acquired again after release', async () => {
    const store = makeStore();
    const first = await store.acquireLock('2026-W42');
    await first.release();
    const second = await store.acquireLock('2026-W43');
    await second.release();
  });

  it('takes over a lock whose process is dead, with a warning', async () => {
    await writeLock({ pid: deadPid(), runId: '2026-W41', startedAt: NOW });

    const lock = await makeStore().acquireLock('2026-W42');

    expectStaleLockWarning('process is not running');
    const content = JSON.parse(await readFile(lockPath(), 'utf8')) as { runId: string };
    expect(content.runId).toBe('2026-W42');
    await expect(readdir(dataDir)).resolves.toEqual(['digest.lock']);
    await lock.release();
  });

  it('takes over a lock older than 6 hours even if its pid is alive', async () => {
    const startedAt = new Date(Date.parse(NOW) - 6 * HOUR_MS).toISOString();
    await writeLock({ pid: process.pid, runId: '2026-W41', startedAt });

    const lock = await makeStore().acquireLock('2026-W42');

    expectStaleLockWarning('lock is too old');
    await lock.release();
  });

  it('respects a live lock younger than 6 hours', async () => {
    const startedAt = new Date(Date.parse(NOW) - 6 * HOUR_MS + 1000).toISOString();
    await writeLock({ pid: process.pid, runId: '2026-W41', startedAt });

    await expect(makeStore().acquireLock('2026-W42')).rejects.toThrow(/pid .*, week 2026-W41/);
    expect(warn).not.toHaveBeenCalled();
  });

  it('treats a pid owned by another user (EPERM) as alive', async () => {
    await writeLock({ pid: 4242, runId: '2026-W41', startedAt: NOW });
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    });

    await expect(makeStore().acquireLock('2026-W42')).rejects.toThrow(
      'Another run is in progress (pid 4242, week 2026-W41)',
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ['unparseable', 'not json'],
    ['empty', ''],
    ['missing fields', JSON.stringify({ pid: process.pid })],
    ['pid 0', JSON.stringify({ pid: 0, runId: '2026-W41', startedAt: NOW })],
  ])('takes over a %s lock file with a warning', async (_label, content) => {
    await writeLock(content);

    const lock = await makeStore().acquireLock('2026-W42');

    expectStaleLockWarning('lock file is unreadable');
    await lock.release();
  });

  it('does not take over while another run is already taking over the stale lock', async () => {
    const stale = { pid: deadPid(), runId: '2026-W41', startedAt: NOW };
    await writeLock(stale);
    await writeFile(guardPath(), JSON.stringify({ ...stale, pid: process.pid, runId: '2026-W43' }));

    await expect(makeStore().acquireLock('2026-W42')).rejects.toThrow(
      `Another run is in progress (pid ${String(process.pid)}, week 2026-W43)`,
    );
    await expect(readFile(lockPath(), 'utf8')).resolves.toBe(JSON.stringify(stale));
  });

  it('clears a takeover guard left behind by a crashed run and then takes over', async () => {
    await writeLock({ pid: deadPid(), runId: '2026-W41', startedAt: NOW });
    await writeFile(
      guardPath(),
      JSON.stringify({ pid: deadPid(), runId: '2026-W41', startedAt: NOW }),
    );

    const lock = await makeStore().acquireLock('2026-W42');

    expect(warn).toHaveBeenCalledWith(
      'Removing abandoned lock takeover guard',
      expect.objectContaining({ reason: 'process is not running' }),
    );
    await expect(readdir(dataDir)).resolves.toEqual(['digest.lock']);
    await lock.release();
  });

  it('creates the data dir when it does not exist yet', async () => {
    const lock = await makeStore().acquireLock('2026-W42');
    await expect(stat(dataDir)).resolves.toBeDefined();
    await lock.release();
  });

  it('rejects an invalid run id without creating a lock', async () => {
    await expect(makeStore().acquireLock('nope')).rejects.toThrow(DigestError);
    await expect(stat(lockPath())).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('takeover guard ownership', () => {
  const other = (): { pid: number; runId: string; startedAt: string } => ({
    pid: process.pid,
    runId: '2026-W43',
    startedAt: NOW,
  });

  it('backs off without touching anything when the guard is replaced mid-takeover', async () => {
    const stale = { pid: deadPid(), runId: '2026-W41', startedAt: NOW };
    await writeLock(stale);
    // Readings: 1 temp file sweep, 2 start time, 3 first look at the lock, 4 the look under our
    // guard. At the fourth another run breaks our guard and puts its own in place.
    let reads = 0;
    const clock = {
      now: (): Date => {
        reads += 1;
        if (reads === 4) writeFileSync(guardPath(), JSON.stringify(other()));
        return new Date(NOW);
      },
    };
    const store = createFsRunStore({ dataDir, clock, logger });

    await expect(store.acquireLock('2026-W42')).rejects.toThrow(
      `Another run is in progress (pid ${String(process.pid)}, week 2026-W43)`,
    );

    await expect(readFile(lockPath(), 'utf8')).resolves.toBe(JSON.stringify(stale));
    await expect(readFile(guardPath(), 'utf8')).resolves.toBe(JSON.stringify(other()));
  });

  it('treats a guard older than 30 seconds as abandoned even if its pid is alive', async () => {
    await writeLock({ pid: deadPid(), runId: '2026-W41', startedAt: NOW });
    const startedAt = new Date(Date.parse(NOW) - 31_000).toISOString();
    await writeFile(guardPath(), JSON.stringify({ ...other(), startedAt }));

    const lock = await makeStore().acquireLock('2026-W42');

    expect(warn).toHaveBeenCalledWith(
      'Removing abandoned lock takeover guard',
      expect.objectContaining({ reason: 'lock is too old' }),
    );
    await lock.release();
  });
});

describe('release', () => {
  it('is safe to call twice', async () => {
    const lock = await makeStore().acquireLock('2026-W42');
    await lock.release();
    await expect(lock.release()).resolves.toBeUndefined();
  });

  it('a second release does not remove a lock acquired after the first', async () => {
    const store = makeStore();
    const first = await store.acquireLock('2026-W42');
    await first.release();
    const second = await store.acquireLock('2026-W42');

    await first.release();

    await expect(stat(lockPath())).resolves.toBeDefined();
    await second.release();
  });

  it('can be retried when removing the lock fails', async () => {
    const lock = await makeStore().acquireLock('2026-W42');
    await chmod(dataDir, 0o500);
    try {
      if (process.getuid?.() !== 0) await expect(lock.release()).rejects.toThrow();
    } finally {
      await chmod(dataDir, 0o700);
    }
    await lock.release();
    await expect(stat(lockPath())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not remove a lock that another run took over', async () => {
    const lock = await makeStore().acquireLock('2026-W42');
    const theirs = { pid: process.pid + 1, runId: '2026-W43', startedAt: NOW };
    await writeLock(theirs);

    await lock.release();

    const content = JSON.parse(await readFile(lockPath(), 'utf8')) as unknown;
    expect(content).toEqual(theirs);
  });

  it('does not fail when the lock file is already gone', async () => {
    const lock = await makeStore().acquireLock('2026-W42');
    await rm(lockPath());
    await expect(lock.release()).resolves.toBeUndefined();
  });
});
