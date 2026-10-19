import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inspect, staleReason } from './liveness';
import type { LockFile, OwnLock } from './lockFile';
import {
  LOCK_HEARTBEAT_TIMEOUT_MS,
  LOCK_MAX_AGE_MS,
  TAKEOVER_GUARD_MAX_AGE_MS,
} from './lockTimings';

const NOW = '2026-01-05T08:00:00.000Z';
const NOW_DATE = new Date(NOW);
const SECOND_MS = 1000;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const HOST = 'this-container';
const OTHER_HOST = 'other-container';
const NAMESPACE = 'pid:[4026532001]';
const OTHER_NAMESPACE = 'pid:[4026532002]';

const iso = (offsetMs = 0): string => new Date(NOW_DATE.getTime() + offsetMs).toISOString();

/** The run asking the question: this process, on HOST, in NAMESPACE. */
const me: OwnLock = {
  pid: process.pid,
  runId: '2026-W42',
  startedAt: NOW,
  hostname: HOST,
  token: 'my-token',
  pidNamespace: NAMESPACE,
  heartbeatAt: NOW,
};

/** A lock as a current run on another machine writes it. */
const remote = (overrides: Partial<LockFile> = {}): LockFile => ({
  pid: 1,
  runId: '2026-W41',
  startedAt: NOW,
  hostname: OTHER_HOST,
  token: 'remote-token',
  heartbeatAt: NOW,
  ...overrides,
});

/** The pid of a process that has exited. Spawned once per file: spawning is slow on a busy machine. */
let exitedPid: number | undefined;
function deadPid(): number {
  if (exitedPid !== undefined) return exitedPid;
  const child = spawnSync(process.execPath, ['-e', '']);
  if (child.error) throw child.error;
  exitedPid = child.pid;
  return exitedPid;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('staleReason: is the holder still there?', () => {
  it('says "process is not running" for a dead pid on this host', () => {
    const lock = remote({ hostname: HOST, pid: deadPid() });

    expect(staleReason(lock, NOW_DATE, me, 'lock')).toBe('process is not running');
  });

  it('says the same for a dead pid in our PID namespace', () => {
    const lock = remote({ hostname: HOST, pidNamespace: NAMESPACE, pid: deadPid() });

    expect(staleReason(lock, NOW_DATE, me, 'lock')).toBe('process is not running');
  });

  it('holds a lock on another host live, whatever its pid looks like from here', () => {
    const lock = remote({ pid: deadPid() });

    expect(staleReason(lock, NOW_DATE, me, 'lock')).toBeUndefined();
  });

  it('holds a lock in another PID namespace live, even on a pinned hostname', () => {
    const lock = remote({ hostname: HOST, pidNamespace: OTHER_NAMESPACE, pid: deadPid() });

    expect(staleReason(lock, NOW_DATE, me, 'lock')).toBeUndefined();
  });

  it('checks the pid of a legacy lock, which names no host or namespace', () => {
    const { hostname: _host, token: _token, heartbeatAt: _beat, ...legacy } = remote();

    expect(staleReason({ ...legacy, pid: deadPid() }, NOW_DATE, me, 'lock')).toBe(
      'process is not running',
    );
  });

  it('checks the pid when we name no namespace (macOS, Windows)', () => {
    const lock = remote({ hostname: HOST, pidNamespace: OTHER_NAMESPACE, pid: deadPid() });
    const { pidNamespace: _namespace, ...withoutNamespace } = me;

    expect(staleReason(lock, NOW_DATE, withoutNamespace, 'lock')).toBe('process is not running');
  });

  it('treats a pid owned by another user (EPERM) as alive', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    });
    const lock = remote({ hostname: HOST, pid: 4242 });

    expect(staleReason(lock, NOW_DATE, me, 'lock')).toBeUndefined();
  });

  it('treats any other error from the pid check as a dead process', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    });
    const lock = remote({ hostname: HOST, pid: 4242 });

    expect(staleReason(lock, NOW_DATE, me, 'lock')).toBe('process is not running');
  });

  it('recognises our pid with another token as a previous incarnation', () => {
    const lock = remote({ hostname: HOST, pid: process.pid, token: 'before-the-restart' });

    expect(staleReason(lock, NOW_DATE, me, 'lock')).toBe(
      'lock was left by a previous process with this pid',
    );
  });

  it('does not doubt our own token', () => {
    const lock = remote({ hostname: HOST, pid: process.pid, token: me.token });

    expect(staleReason(lock, NOW_DATE, me, 'lock')).toBeUndefined();
  });

  it('does not doubt our pid when the lock has no token (a legacy lock)', () => {
    const lock = remote({ hostname: HOST, pid: process.pid, token: undefined });

    expect(staleReason(lock, NOW_DATE, me, 'lock')).toBeUndefined();
  });

  it('holds our pid with another token live when it lives in another PID namespace', () => {
    const lock = remote({ hostname: HOST, pidNamespace: OTHER_NAMESPACE, pid: process.pid });

    expect(staleReason(lock, NOW_DATE, me, 'lock')).toBeUndefined();
  });
});

describe('staleReason: is the heartbeat fresh?', () => {
  it('says "heartbeat is stale" once the heartbeat is a full timeout old', () => {
    const lock = remote({ heartbeatAt: iso(-LOCK_HEARTBEAT_TIMEOUT_MS) });

    expect(staleReason(lock, NOW_DATE, me, 'lock')).toBe('heartbeat is stale');
  });

  it('holds a lock live until then', () => {
    const lock = remote({ heartbeatAt: iso(-(LOCK_HEARTBEAT_TIMEOUT_MS - SECOND_MS)) });

    expect(staleReason(lock, NOW_DATE, me, 'lock')).toBeUndefined();
  });

  it('distrusts a heartbeat a full timeout in the future (a clock that was ahead)', () => {
    const lock = remote({ heartbeatAt: iso(LOCK_HEARTBEAT_TIMEOUT_MS) });

    expect(staleReason(lock, NOW_DATE, me, 'lock')).toBe('heartbeat is stale');
  });

  it('trusts a heartbeat a little in the future (clock skew)', () => {
    const lock = remote({ heartbeatAt: iso(2 * MINUTE_MS) });

    expect(staleReason(lock, NOW_DATE, me, 'lock')).toBeUndefined();
  });

  it('lets a fresh heartbeat outweigh any age: a long run stays live', () => {
    const lock = remote({ startedAt: iso(-(LOCK_MAX_AGE_MS + HOUR_MS)) });

    expect(staleReason(lock, NOW_DATE, me, 'lock')).toBeUndefined();
  });
});

describe('staleReason: a lock without a heartbeat (older versions)', () => {
  const noBeat = (startedAtOffsetMs: number): LockFile => ({
    ...remote({ startedAt: iso(startedAtOffsetMs) }),
    heartbeatAt: undefined,
  });

  it('is judged by its age alone', () => {
    expect(staleReason(noBeat(-LOCK_MAX_AGE_MS), NOW_DATE, me, 'lock')).toBe('lock is too old');
  });

  it('stays live until it is 6 hours old', () => {
    expect(
      staleReason(noBeat(-(LOCK_MAX_AGE_MS - SECOND_MS)), NOW_DATE, me, 'lock'),
    ).toBeUndefined();
  });
});

describe('staleReason: a takeover guard', () => {
  it('expires after 30 seconds, from its start time', () => {
    const guard = remote({ startedAt: iso(-TAKEOVER_GUARD_MAX_AGE_MS) });

    expect(staleReason(guard, NOW_DATE, me, 'guard')).toBe('lock is too old');
  });

  it('is live while younger than that', () => {
    const guard = remote({ startedAt: iso(-(TAKEOVER_GUARD_MAX_AGE_MS - SECOND_MS)) });

    expect(staleReason(guard, NOW_DATE, me, 'guard')).toBeUndefined();
  });

  it('is not kept alive by a heartbeat, unlike a lock', () => {
    const guard = remote({ startedAt: iso(-TAKEOVER_GUARD_MAX_AGE_MS), heartbeatAt: NOW });

    expect(staleReason(guard, NOW_DATE, me, 'guard')).toBe('lock is too old');
  });

  it('is abandoned when its process died on this host', () => {
    const guard = remote({ hostname: HOST, pid: deadPid() });

    expect(staleReason(guard, NOW_DATE, me, 'guard')).toBe('process is not running');
  });
});

describe('inspect: what is at this path?', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'liveness-'));
    path = join(dir, 'digest.lock');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reports a missing file as free', async () => {
    await expect(inspect(path, NOW_DATE, me, 'lock')).resolves.toEqual({ kind: 'free' });
  });

  it('reports a lock with a live holder as held, with the parsed lock', async () => {
    const theirs = remote();
    await writeFile(path, JSON.stringify(theirs));

    await expect(inspect(path, NOW_DATE, me, 'lock')).resolves.toEqual({
      kind: 'held',
      lock: theirs,
    });
  });

  it('reports an abandoned lock as stale, with the reason and the lock', async () => {
    const theirs = remote({ heartbeatAt: iso(-LOCK_HEARTBEAT_TIMEOUT_MS) });
    await writeFile(path, JSON.stringify(theirs));

    await expect(inspect(path, NOW_DATE, me, 'lock')).resolves.toEqual({
      kind: 'stale',
      reason: 'heartbeat is stale',
      lock: theirs,
    });
  });

  it.each([
    ['not json', 'not json'],
    ['empty', ''],
    ['missing fields', JSON.stringify({ pid: process.pid })],
  ])('reports a file that is %s as stale, without a lock', async (_label, content) => {
    await writeFile(path, content);

    await expect(inspect(path, NOW_DATE, me, 'lock')).resolves.toEqual({
      kind: 'stale',
      reason: 'lock file is unreadable',
    });
  });

  it('judges a guard file by the guard rules', async () => {
    await writeFile(path, JSON.stringify(remote({ startedAt: iso(-TAKEOVER_GUARD_MAX_AGE_MS) })));

    await expect(inspect(path, NOW_DATE, me, 'guard')).resolves.toMatchObject({
      kind: 'stale',
      reason: 'lock is too old',
    });
  });

  it('lets an unexpected read error through instead of calling the lock free', async () => {
    await mkdir(path);

    await expect(inspect(path, NOW_DATE, me, 'lock')).rejects.toThrow();
  });
});
