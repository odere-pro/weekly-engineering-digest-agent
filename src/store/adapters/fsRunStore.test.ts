import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createFsRunStore } from './fsRunStore';
import { ExitCode } from '../../domain/schemas';
import type { ArtifactName, RunStore } from '../RunStore';
import { DigestError } from '../../shared/errors';
import { fixedClock } from '../../shared/clock';
import { noopLogger, type Logger } from '../../shared/telemetry';
import { MemoryRunStore } from '../../../test/fakes/MemoryRunStore';
import { makeRunRecord } from '../../../test/builders';

const HOUR_MS = 3_600_000;
const NOW = '2026-10-19T08:00:00.000Z';

let root: string;
let dataDir: string;
let warn: Mock<Logger['warn']>;
let logger: Logger;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fsrunstore-'));
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

function runPath(runId: string, file: string): string {
  return join(dataDir, 'runs', runId, file);
}

function expectRunJsonWarning(runId: string): void {
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith(
    'Ignoring unreadable run.json',
    expect.objectContaining({ runId, path: runPath(runId, 'run.json') }),
  );
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

function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '']);
  if (child.error) throw child.error;
  return child.pid;
}

async function listAll(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true });
  return entries.sort();
}

describe('artifacts', () => {
  it.each<ArtifactName>(['items.json', 'scores.json', 'drafts.json', 'digest.md', 'error.json'])(
    'round-trips %s under runs/<week>/',
    async (name) => {
      const store = makeStore();
      await store.saveArtifact('2026-W42', name, `content of ${name}`);
      await expect(readFile(runPath('2026-W42', name), 'utf8')).resolves.toBe(`content of ${name}`);
    },
  );

  it('overwrites an artifact and leaves no temp files behind', async () => {
    const store = makeStore();
    await store.saveArtifact('2026-W42', 'digest.md', 'first');
    await store.saveArtifact('2026-W42', 'digest.md', 'second');
    await expect(readFile(runPath('2026-W42', 'digest.md'), 'utf8')).resolves.toBe('second');
    await expect(readdir(join(dataDir, 'runs', '2026-W42'))).resolves.toEqual(['digest.md']);
  });

  it('cleans up its temp file when the final rename fails', async () => {
    const store = makeStore();
    await mkdir(runPath('2026-W42', 'digest.md'), { recursive: true });
    await expect(store.saveArtifact('2026-W42', 'digest.md', 'x')).rejects.toThrow();
    await expect(readdir(join(dataDir, 'runs', '2026-W42'))).resolves.toEqual(['digest.md']);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'keeps the previous content when the folder cannot be written to',
    async () => {
      const store = makeStore();
      await store.saveArtifact('2026-W42', 'digest.md', 'previous');
      const dir = join(dataDir, 'runs', '2026-W42');
      await chmod(dir, 0o500);
      try {
        await expect(store.saveArtifact('2026-W42', 'digest.md', 'new')).rejects.toThrow();
      } finally {
        await chmod(dir, 0o700);
      }
      await expect(readFile(runPath('2026-W42', 'digest.md'), 'utf8')).resolves.toBe('previous');
      await expect(readdir(dir)).resolves.toEqual(['digest.md']);
    },
  );

  it('rejects a run id that is not an ISO week and writes nothing', async () => {
    const store = makeStore();
    await expect(store.saveArtifact('../escape', 'digest.md', 'x')).rejects.toThrow(DigestError);
    await expect(store.saveArtifact('2026-W42/../../x', 'digest.md', 'x')).rejects.toThrow(
      DigestError,
    );
    await expect(readdir(root)).resolves.toEqual([]);
  });

  it('rejects an artifact name outside the allowed set', async () => {
    const store = makeStore();
    await expect(
      store.saveArtifact('2026-W42', '../../evil.txt' as ArtifactName, 'x'),
    ).rejects.toThrow(DigestError);
    await expect(readdir(root)).resolves.toEqual([]);
  });

  it('accepts review.md, the reader sheet W7-07 writes next to the digest', async () => {
    const store = makeStore();
    await store.saveArtifact('2026-W42', 'review.md', '# Review');

    await expect(store.readArtifact('2026-W42', 'review.md')).resolves.toBe('# Review');
  });

  it('reads a saved artifact back, and undefined for one never saved', async () => {
    const store = makeStore();
    await store.saveArtifact('2026-W42', 'digest.md', '# Digest');

    await expect(store.readArtifact('2026-W42', 'digest.md')).resolves.toBe('# Digest');
    await expect(store.readArtifact('2026-W42', 'drafts.json')).resolves.toBeUndefined();
    await expect(store.readArtifact('2026-W41', 'digest.md')).resolves.toBeUndefined();
  });

  it('refuses to read outside the week folder', async () => {
    const store = makeStore();
    await expect(store.readArtifact('../escape', 'digest.md')).rejects.toThrow(DigestError);
    await expect(store.readArtifact('2026-W42', '../../evil.txt' as ArtifactName)).rejects.toThrow(
      DigestError,
    );
  });
});

describe('run record', () => {
  it('round-trips a run record through run.json', async () => {
    const store = makeStore();
    const record = makeRunRecord({
      runId: '2026-W42',
      sentUrls: ['https://example.com/a'],
      failedSources: [{ sourceId: 'feed', error: 'timeout' }],
    });
    await store.saveRunRecord(record);

    await expect(store.getRunRecord('2026-W42')).resolves.toEqual(record);
    const onDisk = JSON.parse(await readFile(runPath('2026-W42', 'run.json'), 'utf8')) as unknown;
    expect(onDisk).toEqual(record);
  });

  it('replaces the record when saved again', async () => {
    const store = makeStore();
    await store.saveRunRecord(makeRunRecord({ runId: '2026-W42', status: 'failed' }));
    await store.saveRunRecord(makeRunRecord({ runId: '2026-W42', status: 'sent' }));
    await expect(store.getRunRecord('2026-W42')).resolves.toMatchObject({ status: 'sent' });
  });

  it('returns undefined for a week that has no record', async () => {
    const store = makeStore();
    await expect(store.getRunRecord('2026-W42')).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('refuses to write a record that fails RunRecordSchema', async () => {
    const store = makeStore();
    const invalid = { ...makeRunRecord(), status: 'bogus' } as unknown as ReturnType<
      typeof makeRunRecord
    >;
    await expect(store.saveRunRecord(invalid)).rejects.toThrow();
    await expect(store.getRunRecord('2026-W42')).resolves.toBeUndefined();
  });

  it('treats unparseable run.json as missing and warns', async () => {
    const store = makeStore();
    await mkdir(join(dataDir, 'runs', '2026-W42'), { recursive: true });
    await writeFile(runPath('2026-W42', 'run.json'), '{ not json');

    await expect(store.getRunRecord('2026-W42')).resolves.toBeUndefined();
    expectRunJsonWarning('2026-W42');
  });

  it('treats schema-invalid run.json as missing and warns', async () => {
    const store = makeStore();
    await mkdir(join(dataDir, 'runs', '2026-W42'), { recursive: true });
    await writeFile(runPath('2026-W42', 'run.json'), JSON.stringify({ runId: '2026-W42' }));

    await expect(store.getRunRecord('2026-W42')).resolves.toBeUndefined();
    expectRunJsonWarning('2026-W42');
  });

  it('treats a run.json whose runId differs from its folder as missing', async () => {
    const store = makeStore();
    await mkdir(join(dataDir, 'runs', '2026-W42'), { recursive: true });
    await writeFile(
      runPath('2026-W42', 'run.json'),
      JSON.stringify(makeRunRecord({ runId: '2026-W41' })),
    );

    await expect(store.getRunRecord('2026-W42')).resolves.toBeUndefined();
    expectRunJsonWarning('2026-W42');
  });
});

describe('hasSentDigest', () => {
  it('is true only when the week status is sent', async () => {
    const store = makeStore();
    const statuses = ['sent', 'dry-run', 'skipped', 'quiet', 'blocked', 'failed'] as const;
    for (const [i, status] of statuses.entries()) {
      await store.saveRunRecord(makeRunRecord({ runId: `2026-W${String(10 + i)}`, status }));
    }

    const results = await Promise.all(
      statuses.map((_, i) => store.hasSentDigest(`2026-W${String(10 + i)}`)),
    );
    expect(results).toEqual([true, false, false, false, false, false]);
  });

  it('is false for a week without a record', async () => {
    await expect(makeStore().hasSentDigest('2026-W42')).resolves.toBe(false);
  });

  it('is false when run.json is corrupt', async () => {
    const store = makeStore();
    await mkdir(join(dataDir, 'runs', '2026-W42'), { recursive: true });
    await writeFile(runPath('2026-W42', 'run.json'), 'garbage');
    await expect(store.hasSentDigest('2026-W42')).resolves.toBe(false);
  });
});

describe('sentUrls', () => {
  it('collects URLs from sent runs in the window before the run id', async () => {
    const store = makeStore();
    await store.saveRunRecord(
      makeRunRecord({ runId: '2026-W41', sentUrls: ['https://example.com/w41'] }),
    );
    await store.saveRunRecord(
      makeRunRecord({ runId: '2026-W40', sentUrls: ['https://example.com/w40'] }),
    );
    await store.saveRunRecord(
      makeRunRecord({ runId: '2026-W42', sentUrls: ['https://example.com/current'] }),
    );

    const urls = await store.sentUrls('2026-W42', 2);
    expect([...urls].sort()).toEqual(['https://example.com/w40', 'https://example.com/w41']);
  });

  it('ignores weeks outside the window', async () => {
    const store = makeStore();
    await store.saveRunRecord(
      makeRunRecord({ runId: '2026-W38', sentUrls: ['https://example.com/old'] }),
    );
    expect((await store.sentUrls('2026-W42', 2)).size).toBe(0);
  });

  it('ignores runs whose status is not sent', async () => {
    const store = makeStore();
    await store.saveRunRecord(
      makeRunRecord({ runId: '2026-W41', status: 'failed', sentUrls: ['https://example.com/f'] }),
    );
    await store.saveRunRecord(
      makeRunRecord({ runId: '2026-W40', status: 'dry-run', sentUrls: ['https://example.com/d'] }),
    );
    expect((await store.sentUrls('2026-W42', 4)).size).toBe(0);
  });

  it('counts the URLs of a partly delivered week, so they are deduped next week', async () => {
    const store = makeStore();
    await store.saveRunRecord(
      makeRunRecord({
        runId: '2026-W41',
        status: 'failed',
        deliveredTo: ['markdown'],
        sentUrls: ['https://example.com/partial'],
      }),
    );
    expect([...(await store.sentUrls('2026-W42', 2))]).toEqual(['https://example.com/partial']);
  });

  it('ignores a failed run whose deliveredTo is empty or absent', async () => {
    const store = makeStore();
    await store.saveRunRecord(
      makeRunRecord({
        runId: '2026-W41',
        status: 'failed',
        deliveredTo: [],
        sentUrls: ['https://example.com/empty'],
      }),
    );
    await store.saveRunRecord(
      makeRunRecord({
        runId: '2026-W40',
        status: 'failed',
        sentUrls: ['https://example.com/none'],
      }),
    );
    expect((await store.sentUrls('2026-W42', 4)).size).toBe(0);
  });

  it('crosses the year boundary', async () => {
    const store = makeStore();
    await store.saveRunRecord(
      makeRunRecord({ runId: '2025-W52', sentUrls: ['https://example.com/ny'] }),
    );
    expect([...(await store.sentUrls('2026-W02', 2))]).toEqual(['https://example.com/ny']);
  });

  it('skips corrupt run records', async () => {
    const store = makeStore();
    await mkdir(join(dataDir, 'runs', '2026-W41'), { recursive: true });
    await writeFile(runPath('2026-W41', 'run.json'), '{');
    await store.saveRunRecord(
      makeRunRecord({ runId: '2026-W40', sentUrls: ['https://example.com/ok'] }),
    );
    expect([...(await store.sentUrls('2026-W42', 3))]).toEqual(['https://example.com/ok']);
  });
});

describe('listRuns', () => {
  it('returns records most recent first', async () => {
    const store = makeStore();
    for (const runId of ['2026-W40', '2026-W42', '2025-W52', '2026-W41']) {
      await store.saveRunRecord(makeRunRecord({ runId }));
    }
    const runs = await store.listRuns();
    expect(runs.map((r) => r.runId)).toEqual(['2026-W42', '2026-W41', '2026-W40', '2025-W52']);
  });

  it('honours the limit', async () => {
    const store = makeStore();
    for (const runId of ['2026-W40', '2026-W41', '2026-W42']) {
      await store.saveRunRecord(makeRunRecord({ runId }));
    }
    const runs = await store.listRuns(2);
    expect(runs.map((r) => r.runId)).toEqual(['2026-W42', '2026-W41']);
  });

  it('returns an empty list when nothing has run yet', async () => {
    await expect(makeStore().listRuns()).resolves.toEqual([]);
  });

  it('skips corrupt records and still fills the limit', async () => {
    const store = makeStore();
    await store.saveRunRecord(makeRunRecord({ runId: '2026-W40' }));
    await store.saveRunRecord(makeRunRecord({ runId: '2026-W41' }));
    await mkdir(join(dataDir, 'runs', '2026-W42'), { recursive: true });
    await writeFile(runPath('2026-W42', 'run.json'), 'broken');

    const runs = await store.listRuns(2);
    expect(runs.map((r) => r.runId)).toEqual(['2026-W41', '2026-W40']);
  });

  it('ignores folders and files that are not week ids, and weeks without run.json', async () => {
    const store = makeStore();
    await store.saveRunRecord(makeRunRecord({ runId: '2026-W41' }));
    await mkdir(join(dataDir, 'runs', 'notes'), { recursive: true });
    await writeFile(join(dataDir, 'runs', '.DS_Store'), '');
    await store.saveArtifact('2026-W42', 'digest.md', 'only a digest');

    const runs = await store.listRuns();
    expect(runs.map((r) => r.runId)).toEqual(['2026-W41']);
  });
});

describe('prune', () => {
  async function seedWeek(store: RunStore, runId: string): Promise<void> {
    await store.saveRunRecord(makeRunRecord({ runId }));
    for (const name of ['items.json', 'scores.json', 'drafts.json', 'digest.md'] as const) {
      await store.saveArtifact(runId, name, `${runId}/${name}`);
    }
  }

  it('deletes everything but digest.md for weeks older than the kept window', async () => {
    const store = makeStore();
    await seedWeek(store, '2026-W30');
    await seedWeek(store, '2026-W41');
    await seedWeek(store, '2026-W42');

    const pruned = await store.prune('2026-W42', 3);

    expect(pruned).toEqual(['2026-W30']);
    await expect(readdir(join(dataDir, 'runs', '2026-W30'))).resolves.toEqual(['digest.md']);
    await expect(readFile(runPath('2026-W30', 'digest.md'), 'utf8')).resolves.toBe(
      '2026-W30/digest.md',
    );
  });

  it('keeps the current week and every week inside the window untouched', async () => {
    const store = makeStore();
    await seedWeek(store, '2026-W39');
    await seedWeek(store, '2026-W42');
    const before = await listAll(join(dataDir, 'runs'));

    await expect(store.prune('2026-W42', 3)).resolves.toEqual([]);
    await expect(listAll(join(dataDir, 'runs'))).resolves.toEqual(before);
  });

  it('prunes the first week outside the window', async () => {
    const store = makeStore();
    await seedWeek(store, '2026-W38');
    await seedWeek(store, '2026-W39');

    await expect(store.prune('2026-W42', 3)).resolves.toEqual(['2026-W38']);
    await expect(store.getRunRecord('2026-W38')).resolves.toBeUndefined();
    await expect(store.getRunRecord('2026-W39')).resolves.toBeDefined();
  });

  it('never touches weeks newer than the run id', async () => {
    const store = makeStore();
    await seedWeek(store, '2026-W44');
    await expect(store.prune('2026-W42', 1)).resolves.toEqual([]);
    await expect(store.getRunRecord('2026-W44')).resolves.toBeDefined();
  });

  it('is idempotent: an already pruned week is not reported again', async () => {
    const store = makeStore();
    await seedWeek(store, '2026-W30');
    await expect(store.prune('2026-W42', 3)).resolves.toEqual(['2026-W30']);
    await expect(store.prune('2026-W42', 3)).resolves.toEqual([]);
    await expect(readdir(join(dataDir, 'runs', '2026-W30'))).resolves.toEqual(['digest.md']);
  });

  it('removes subfolders and corrupt run.json of old weeks, and ignores stray entries', async () => {
    const store = makeStore();
    await mkdir(join(dataDir, 'runs', '2026-W20', 'extra'), { recursive: true });
    await writeFile(runPath('2026-W20', 'run.json'), 'broken');
    await writeFile(runPath('2026-W20', 'extra/x.txt'), 'x');
    await mkdir(join(dataDir, 'runs', 'notes'), { recursive: true });
    await writeFile(join(dataDir, 'runs', 'stray.txt'), 'x');

    await expect(store.prune('2026-W42', 3)).resolves.toEqual(['2026-W20']);
    await expect(readdir(join(dataDir, 'runs', '2026-W20'))).resolves.toEqual([]);
    await expect(stat(join(dataDir, 'runs', 'notes'))).resolves.toBeDefined();
    await expect(stat(join(dataDir, 'runs', 'stray.txt'))).resolves.toBeDefined();
  });

  it('returns an empty list when there is no runs folder', async () => {
    await expect(makeStore().prune('2026-W42', 12)).resolves.toEqual([]);
  });
});

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
    // The third clock reading happens while this run holds the guard and re-inspects the lock:
    // another run breaks our guard and puts its own in place at exactly that moment.
    let reads = 0;
    const clock = {
      now: (): Date => {
        reads += 1;
        if (reads === 3) writeFileSync(guardPath(), JSON.stringify(other()));
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

describe('edge cases', () => {
  it('prune with keepWeeks 0 keeps only the current week', async () => {
    const store = makeStore();
    for (const runId of ['2026-W40', '2026-W41', '2026-W42']) {
      await store.saveRunRecord(makeRunRecord({ runId }));
    }
    await expect(store.prune('2026-W42', 0)).resolves.toEqual(['2026-W41', '2026-W40']);
    await expect(store.getRunRecord('2026-W42')).resolves.toBeDefined();
  });

  it('prune compares weeks across the year boundary', async () => {
    const store = makeStore();
    for (const runId of ['2025-W40', '2025-W52', '2026-W01']) {
      await store.saveRunRecord(makeRunRecord({ runId }));
    }
    await expect(store.prune('2026-W02', 2)).resolves.toEqual(['2025-W40']);
  });

  it('a plain file named like a week id does not break listing or pruning', async () => {
    const store = makeStore();
    await store.saveRunRecord(makeRunRecord({ runId: '2026-W41' }));
    await writeFile(join(dataDir, 'runs', '2026-W20'), 'not a folder');

    await expect(store.listRuns()).resolves.toHaveLength(1);
    await expect(store.prune('2026-W42', 3)).resolves.toEqual([]);
  });

  it('refuses an invalid run id on every method that takes one', async () => {
    const store = makeStore();
    await expect(store.getRunRecord('latest')).rejects.toThrow(DigestError);
    await expect(store.hasSentDigest('../x')).rejects.toThrow(DigestError);
    await expect(store.sentUrls('x', 2)).rejects.toThrow(DigestError);
    await expect(store.prune('x', 2)).rejects.toThrow(DigestError);
    await expect(store.saveRunRecord({ ...makeRunRecord(), runId: '2026-W99' })).rejects.toThrow();
  });
});

describe('contract parity with MemoryRunStore', () => {
  async function seed(store: RunStore): Promise<void> {
    const weeks = ['2025-W51', '2025-W52', '2026-W01', '2026-W30', '2026-W41', '2026-W42'];
    const statuses = ['sent', 'failed', 'sent', 'dry-run', 'sent', 'quiet'] as const;
    for (const [i, runId] of weeks.entries()) {
      await store.saveRunRecord(
        makeRunRecord({
          runId,
          status: statuses[i],
          sentUrls: [`https://example.com/${runId}`],
        }),
      );
    }
  }

  async function seedPartlyDelivered(store: RunStore): Promise<void> {
    await store.saveRunRecord(
      makeRunRecord({
        runId: '2026-W35',
        status: 'failed',
        deliveredTo: ['markdown'],
        sentUrls: ['https://example.com/2026-W35'],
      }),
    );
    await store.saveRunRecord(
      makeRunRecord({
        runId: '2026-W36',
        status: 'failed',
        deliveredTo: [],
        sentUrls: ['https://example.com/2026-W36'],
      }),
    );
  }

  async function observe(store: RunStore): Promise<unknown> {
    await seedPartlyDelivered(store);
    await seed(store);
    return {
      sent: await Promise.all(
        ['2025-W51', '2025-W52', '2026-W42', '2026-W50'].map((id) => store.hasSentDigest(id)),
      ),
      urls: [...(await store.sentUrls('2026-W42', 3))].sort(),
      wideUrls: [...(await store.sentUrls('2026-W42', 12))].sort(),
      listed: (await store.listRuns(4)).map((r) => r.runId),
      // The port does not specify the order of pruned ids.
      pruned: (await store.prune('2026-W42', 3)).sort(),
      remaining: (await store.listRuns()).map((r) => r.runId),
    };
  }

  it('returns the same answers as the in-memory store', async () => {
    const fromDisk = await observe(makeStore());
    const fromMemory = await observe(new MemoryRunStore());
    expect(fromDisk).toEqual(fromMemory);
  });
});

describe('unexpected filesystem errors', () => {
  it('propagate instead of being treated as missing data', async () => {
    const store = makeStore();
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, 'runs'), 'a file where the runs folder should be');

    await expect(store.listRuns()).rejects.toThrow();
    await expect(store.getRunRecord('2026-W42')).rejects.toThrow();
    await expect(store.prune('2026-W42', 3)).rejects.toThrow();
  });
});

describe('defaults', () => {
  it('works without a clock or a logger', async () => {
    const store = createFsRunStore({ dataDir });
    const lock = await store.acquireLock('2026-W42');
    await store.saveRunRecord(makeRunRecord({ runId: '2026-W42' }));
    await expect(store.hasSentDigest('2026-W42')).resolves.toBe(true);
    await lock.release();
  });
});
