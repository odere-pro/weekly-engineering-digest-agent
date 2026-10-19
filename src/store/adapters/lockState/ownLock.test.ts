import { readlink } from 'node:fs/promises';
import { hostname as osHostname } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildOwnLock, readPidNamespace } from './ownLock';
import { parseLockFile } from './lockFile';
import type * as Os from 'node:os';

// The machine name is read once per lock; a test can blank it.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof Os>();
  return { ...actual, hostname: vi.fn(actual.hostname) };
});

const NOW = '2026-01-05T08:00:00.000Z';
const clock = { now: () => new Date(NOW) };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildOwnLock', () => {
  it('describes this process: pid, run, start time, first heartbeat and a token', async () => {
    const lock = await buildOwnLock({
      runId: '2026-W42',
      clock,
      hostname: 'this-container',
      pidNamespace: 'pid:[4026532001]',
    });

    expect(lock).toEqual({
      pid: process.pid,
      runId: '2026-W42',
      startedAt: NOW,
      hostname: 'this-container',
      token: expect.stringMatching(/^[0-9a-f-]{36}$/) as string,
      pidNamespace: 'pid:[4026532001]',
      heartbeatAt: NOW,
    });
  });

  it('uses one token for every lock this process builds', async () => {
    const first = await buildOwnLock({ runId: '2026-W42', clock, hostname: 'h' });
    const second = await buildOwnLock({ runId: '2026-W43', clock, hostname: 'h' });

    expect(second.token).toBe(first.token);
  });

  it('names this machine with os.hostname() by default', async () => {
    const lock = await buildOwnLock({ runId: '2026-W42', clock });

    expect(lock.hostname).toBe(osHostname());
  });

  it('falls back to a name when the machine reports an empty hostname', async () => {
    vi.mocked(osHostname).mockReturnValueOnce('');

    const lock = await buildOwnLock({ runId: '2026-W42', clock });

    expect(lock.hostname).toBe('unknown');
  });

  it('builds a lock its own parser accepts, even with an empty machine name', async () => {
    vi.mocked(osHostname).mockReturnValueOnce('');

    const lock = await buildOwnLock({ runId: '2026-W42', clock });

    expect(parseLockFile(JSON.stringify(lock))).toEqual(lock);
  });

  it('names the PID namespace from /proc by default, where there is one', async () => {
    const expected = await readlink('/proc/self/ns/pid').catch(() => undefined);

    const lock = await buildOwnLock({ runId: '2026-W42', clock, hostname: 'h' });

    expect(lock.pidNamespace).toBe(expected);
  });

  it('reads the clock once, for both the start time and the first heartbeat', async () => {
    const now = vi.fn(() => new Date(NOW));

    const lock = await buildOwnLock({ runId: '2026-W42', clock: { now }, hostname: 'h' });

    expect(now).toHaveBeenCalledTimes(1);
    expect(lock.heartbeatAt).toBe(lock.startedAt);
  });
});

describe('readPidNamespace', () => {
  it('returns the namespace link of this process, or nothing where /proc has none', async () => {
    const expected = await readlink('/proc/self/ns/pid').catch(() => undefined);

    await expect(readPidNamespace()).resolves.toBe(expected);
  });
});
