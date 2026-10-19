import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLockFile, isOurs, parseLockFile, sameLock, type OwnLock } from './lockFile';

const NOW = '2026-01-05T08:00:00.000Z';
const LATER = '2026-01-05T08:01:00.000Z';

const mine: OwnLock = {
  pid: 4242,
  runId: '2026-W42',
  startedAt: NOW,
  hostname: 'this-container',
  token: 'my-token',
  pidNamespace: 'pid:[4026532001]',
  heartbeatAt: NOW,
};

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lockfile-'));
  path = join(dir, 'digest.lock');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('parseLockFile', () => {
  it('reads a complete lock', () => {
    expect(parseLockFile(JSON.stringify(mine))).toEqual(mine);
  });

  it('reads a legacy lock with only a pid, a run and a start time', () => {
    const legacy = { pid: 7, runId: '2026-W41', startedAt: NOW };

    expect(parseLockFile(JSON.stringify(legacy))).toEqual(legacy);
  });

  it('accepts a time zone offset instead of Z', () => {
    const lock = { pid: 7, runId: '2026-W41', startedAt: '2026-01-05T09:00:00+01:00' };

    expect(parseLockFile(JSON.stringify(lock))).toEqual(lock);
  });

  it('drops fields it does not know', () => {
    const text = JSON.stringify({ ...mine, futureField: true });

    expect(parseLockFile(text)).toEqual(mine);
  });

  it.each([
    ['not json', 'not json'],
    ['empty', ''],
    ['JSON that is not an object', '42'],
    ['missing fields', JSON.stringify({ pid: 7 })],
    ['pid 0', JSON.stringify({ ...mine, pid: 0 })],
    ['a negative pid', JSON.stringify({ ...mine, pid: -3 })],
    ['a fractional pid', JSON.stringify({ ...mine, pid: 1.5 })],
    ['a start time that is not a date', JSON.stringify({ ...mine, startedAt: 'yesterday' })],
    ['a heartbeat that is not a date', JSON.stringify({ ...mine, heartbeatAt: 'yesterday' })],
    ['an empty hostname', JSON.stringify({ ...mine, hostname: '' })],
    ['an empty token', JSON.stringify({ ...mine, token: '' })],
    ['an empty PID namespace', JSON.stringify({ ...mine, pidNamespace: '' })],
  ])('refuses %s', (_label, text) => {
    expect(parseLockFile(text)).toBeUndefined();
  });
});

describe('sameLock', () => {
  it('ignores heartbeats, the only field a holder rewrites', () => {
    expect(sameLock(mine, { ...mine, heartbeatAt: LATER })).toBe(true);
  });

  it('ignores host and namespace, which never change for one holder', () => {
    expect(sameLock(mine, { ...mine, hostname: 'elsewhere', pidNamespace: undefined })).toBe(true);
  });

  it.each([
    ['pid', { pid: 4243 }],
    ['run', { runId: '2026-W43' }],
    ['start time', { startedAt: LATER }],
    ['token', { token: 'their-token' }],
  ])('tells two locks apart by their %s', (_field, change) => {
    expect(sameLock(mine, { ...mine, ...change })).toBe(false);
  });

  it('tells a legacy lock (no token) from one with a token', () => {
    const { token: _token, ...legacy } = mine;

    expect(sameLock(mine, legacy)).toBe(false);
    expect(sameLock(legacy, { ...legacy })).toBe(true);
  });
});

describe('createLockFile', () => {
  it('writes the lock as JSON and says so', async () => {
    await expect(createLockFile(path, mine)).resolves.toBe(true);

    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(mine);
  });

  it('leaves an existing file alone and says it did not create one', async () => {
    await writeFile(path, 'theirs');

    await expect(createLockFile(path, mine)).resolves.toBe(false);

    expect(await readFile(path, 'utf8')).toBe('theirs');
  });

  it('lets exactly one of two concurrent creators win', async () => {
    const results = await Promise.all([createLockFile(path, mine), createLockFile(path, mine)]);

    expect(results.sort()).toEqual([false, true]);
  });

  it('leaves no temp file behind, win or lose', async () => {
    await createLockFile(path, mine);
    await createLockFile(path, mine);

    expect(await readdir(dir)).toEqual(['digest.lock']);
  });
});

describe('isOurs', () => {
  it('is true for the file we created', async () => {
    await createLockFile(path, mine);

    await expect(isOurs(path, mine)).resolves.toBe(true);
  });

  it('stays true when only the heartbeat moved', async () => {
    await writeFile(path, JSON.stringify({ ...mine, heartbeatAt: LATER }));

    await expect(isOurs(path, mine)).resolves.toBe(true);
  });

  it('is false when another run holds the file', async () => {
    await writeFile(path, JSON.stringify({ ...mine, pid: 1, token: 'their-token' }));

    await expect(isOurs(path, mine)).resolves.toBe(false);
  });

  it('is false when the file is gone', async () => {
    await expect(isOurs(path, mine)).resolves.toBe(false);
  });

  it('is false when the file cannot be parsed', async () => {
    await writeFile(path, 'not json');

    await expect(isOurs(path, mine)).resolves.toBe(false);
  });

  it('lets an unexpected read error through instead of guessing', async () => {
    await mkdir(path);

    await expect(isOurs(path, mine)).rejects.toThrow();
  });
});
