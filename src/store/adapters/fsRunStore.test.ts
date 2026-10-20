import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ARTIFACT_FILES } from './artifactFiles';
import { createFsRunStore } from './fsRunStore';
import type { ArtifactName, RunStore } from '../RunStore';
import { weekDigestDir } from '../layout';
import { isLockHeldError } from '../lockHeld';
import { DigestError } from '../../shared/errors';
import { fixedClock } from '../../shared/clock';
import { noopLogger, type Logger } from '../../shared/telemetry';
import { MemoryRunStore } from '../../../test/fakes/MemoryRunStore';
import { makeRunRecord } from '../../../test/builders';

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
  return join(weekDigestDir(dataDir, runId), file);
}

function expectRunJsonWarning(runId: string): void {
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith(
    'Ignoring unreadable run.json',
    expect.objectContaining({ runId, path: runPath(runId, 'run.json') }),
  );
}

async function listAll(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true });
  return entries.sort();
}

describe('artifacts', () => {
  // Driven by the artifact table, so a new artifact name is covered the day it is added.
  it.each(Object.keys(ARTIFACT_FILES) as ArtifactName[])(
    'round-trips %s under <monday>/digest/',
    async (name) => {
      const store = makeStore();
      await store.saveArtifact('2026-W42', name, `content of ${name}`);
      await expect(readFile(runPath('2026-W42', ARTIFACT_FILES[name]), 'utf8')).resolves.toBe(
        `content of ${name}`,
      );
      await expect(store.readArtifact('2026-W42', name)).resolves.toBe(`content of ${name}`);
    },
  );

  it('overwrites an artifact and leaves no temp files behind', async () => {
    const store = makeStore();
    await store.saveArtifact('2026-W42', 'digest.md', 'first');
    await store.saveArtifact('2026-W42', 'digest.md', 'second');
    await expect(readFile(runPath('2026-W42', 'digest.md'), 'utf8')).resolves.toBe('second');
    await expect(readdir(weekDigestDir(dataDir, '2026-W42'))).resolves.toEqual(['digest.md']);
  });

  it('cleans up its temp file when the final rename fails', async () => {
    const store = makeStore();
    await mkdir(runPath('2026-W42', 'digest.md'), { recursive: true });
    await expect(store.saveArtifact('2026-W42', 'digest.md', 'x')).rejects.toThrow();
    await expect(readdir(weekDigestDir(dataDir, '2026-W42'))).resolves.toEqual(['digest.md']);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'keeps the previous content when the folder cannot be written to',
    async () => {
      const store = makeStore();
      await store.saveArtifact('2026-W42', 'digest.md', 'previous');
      const dir = weekDigestDir(dataDir, '2026-W42');
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

  it('checks the artifact name before the run id, and refuses names every object has', async () => {
    const store = makeStore();
    const name = 'constructor' as ArtifactName;

    await expect(store.saveArtifact('../escape', name, 'x')).rejects.toThrow(
      'Unknown artifact name "constructor"',
    );
    await expect(store.readArtifact('../escape', name)).rejects.toThrow(
      'Unknown artifact name "constructor"',
    );
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

  it('removes an artifact and leaves the others of the week', async () => {
    const store = makeStore();
    await store.saveArtifact('2026-W42', 'error.json', '{}');
    await store.saveArtifact('2026-W42', 'digest.md', '# Digest');

    await store.removeArtifact('2026-W42', 'error.json');

    await expect(store.readArtifact('2026-W42', 'error.json')).resolves.toBeUndefined();
    await expect(store.readArtifact('2026-W42', 'digest.md')).resolves.toBe('# Digest');
  });

  it('removes nothing, without complaint, when the week has no such artifact or no folder', async () => {
    const store = makeStore();

    await expect(store.removeArtifact('2026-W42', 'error.json')).resolves.toBeUndefined();
  });

  it('refuses to remove anything outside the week folder', async () => {
    const store = makeStore();
    await expect(store.removeArtifact('../escape', 'error.json')).rejects.toThrow(DigestError);
    await expect(
      store.removeArtifact('2026-W42', '../../evil.txt' as ArtifactName),
    ).rejects.toThrow(DigestError);
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
    await mkdir(weekDigestDir(dataDir, '2026-W42'), { recursive: true });
    await writeFile(runPath('2026-W42', 'run.json'), '{ not json');

    await expect(store.getRunRecord('2026-W42')).resolves.toBeUndefined();
    expectRunJsonWarning('2026-W42');
  });

  it('treats schema-invalid run.json as missing and warns', async () => {
    const store = makeStore();
    await mkdir(weekDigestDir(dataDir, '2026-W42'), { recursive: true });
    await writeFile(runPath('2026-W42', 'run.json'), JSON.stringify({ runId: '2026-W42' }));

    await expect(store.getRunRecord('2026-W42')).resolves.toBeUndefined();
    expectRunJsonWarning('2026-W42');
  });

  it('treats a run.json whose runId differs from its folder as missing', async () => {
    const store = makeStore();
    await mkdir(weekDigestDir(dataDir, '2026-W42'), { recursive: true });
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
    await mkdir(weekDigestDir(dataDir, '2026-W42'), { recursive: true });
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
    await mkdir(weekDigestDir(dataDir, '2026-W41'), { recursive: true });
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
    await mkdir(weekDigestDir(dataDir, '2026-W42'), { recursive: true });
    await writeFile(runPath('2026-W42', 'run.json'), 'broken');

    const runs = await store.listRuns(2);
    expect(runs.map((r) => r.runId)).toEqual(['2026-W41', '2026-W40']);
  });

  it('ignores folders and files that are not week ids, and weeks without run.json', async () => {
    const store = makeStore();
    await store.saveRunRecord(makeRunRecord({ runId: '2026-W41' }));
    await mkdir(join(dataDir, 'notes'), { recursive: true });
    await writeFile(join(dataDir, '.DS_Store'), '');
    // A `digest fetch` day (a Wednesday) and a Monday with source data but no digest folder.
    await mkdir(join(dataDir, '2026-10-14', 'openai-news', 'raw'), { recursive: true });
    await mkdir(join(dataDir, '2026-09-28', 'openai-news', 'raw'), { recursive: true });
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
    await expect(readdir(weekDigestDir(dataDir, '2026-W30'))).resolves.toEqual(['digest.md']);
    await expect(readFile(runPath('2026-W30', 'digest.md'), 'utf8')).resolves.toBe(
      '2026-W30/digest.md',
    );
  });

  it("deletes an old week's source folders but keeps the files the Markdown channel wrote", async () => {
    const store = makeStore();
    await seedWeek(store, '2026-W30');
    const digestDir = weekDigestDir(dataDir, '2026-W30');
    for (const name of ['2026-W30.md', '2026-W30.html', '2026-W30.failed.md']) {
      await writeFile(join(digestDir, name), name);
    }
    // 2026-07-20 is the Monday of 2026-W30.
    await mkdir(join(dataDir, '2026-07-20', 'openai-news', 'raw'), { recursive: true });
    await writeFile(join(dataDir, '2026-07-20', 'openai-news', 'raw', 'feed.xml'), '<rss/>');

    await expect(store.prune('2026-W42', 3)).resolves.toEqual(['2026-W30']);

    await expect(readdir(join(dataDir, '2026-07-20'))).resolves.toEqual(['digest']);
    await expect(readdir(digestDir).then((names) => names.sort())).resolves.toEqual([
      '2026-W30.failed.md',
      '2026-W30.html',
      '2026-W30.md',
      'digest.md',
    ]);
  });

  it('deletes `digest fetch` days and log days older than the kept window, and keeps newer ones', async () => {
    const store = makeStore();
    await seedWeek(store, '2026-W42');
    // The window of 2026-W42 with keepWeeks 3 starts on 2026-09-21, the Monday of 2026-W39.
    for (const day of ['2026-09-16', '2026-09-21', '2026-10-14']) {
      await mkdir(join(dataDir, day, 'openai-news', 'raw'), { recursive: true });
      await mkdir(join(dataDir, 'logs', day), { recursive: true });
      await writeFile(join(dataDir, 'logs', day, 'digest.log'), '{}\n');
    }
    await mkdir(join(dataDir, 'artifacts'), { recursive: true });

    await expect(store.prune('2026-W42', 3)).resolves.toEqual([]);

    const left = (await readdir(dataDir)).sort();
    expect(left).toEqual(['2026-09-21', '2026-10-12', '2026-10-14', 'artifacts', 'logs']);
    await expect(readdir(join(dataDir, 'logs'))).resolves.toEqual(['2026-09-21', '2026-10-14']);
  });

  it('removes a stale temp file next to the delivered files of a pruned week', async () => {
    const store = makeStore();
    await seedWeek(store, '2026-W30');
    const digestDir = weekDigestDir(dataDir, '2026-W30');
    await writeFile(join(digestDir, '2026-W30.md'), 'delivered');
    await writeFile(join(digestDir, '2026-W30.md.123.abc.tmp'), 'half');

    await store.prune('2026-W42', 3);

    await expect(readdir(digestDir).then((names) => names.sort())).resolves.toEqual([
      '2026-W30.md',
      'digest.md',
    ]);
  });

  it('keeps the current week and every week inside the window untouched', async () => {
    const store = makeStore();
    await seedWeek(store, '2026-W39');
    await seedWeek(store, '2026-W42');
    const before = await listAll(dataDir);

    await expect(store.prune('2026-W42', 3)).resolves.toEqual([]);
    await expect(listAll(dataDir)).resolves.toEqual(before);
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
    await expect(readdir(weekDigestDir(dataDir, '2026-W30'))).resolves.toEqual(['digest.md']);
  });

  it('removes subfolders and corrupt run.json of old weeks, and ignores stray entries', async () => {
    const store = makeStore();
    await mkdir(join(weekDigestDir(dataDir, '2026-W20'), 'extra'), { recursive: true });
    await writeFile(runPath('2026-W20', 'run.json'), 'broken');
    await writeFile(runPath('2026-W20', 'extra/x.txt'), 'x');
    await mkdir(join(dataDir, 'notes'), { recursive: true });
    await writeFile(join(dataDir, 'stray.txt'), 'x');

    await expect(store.prune('2026-W42', 3)).resolves.toEqual(['2026-W20']);
    await expect(readdir(weekDigestDir(dataDir, '2026-W20'))).resolves.toEqual([]);
    await expect(stat(join(dataDir, 'notes'))).resolves.toBeDefined();
    await expect(stat(join(dataDir, 'stray.txt'))).resolves.toBeDefined();
  });

  it('returns an empty list when there is no data folder', async () => {
    await expect(makeStore().prune('2026-W42', 12)).resolves.toEqual([]);
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
    // 2026-05-11 is the Monday of 2026-W20.
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, '2026-05-11'), 'not a folder');

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

  /** What is left of a week's files after error.json is removed, twice: the second finds none. */
  async function removedArtifact(store: RunStore): Promise<unknown> {
    await store.saveArtifact('2026-W42', 'error.json', '{}');
    await store.saveArtifact('2026-W42', 'digest.md', '# Digest');
    await store.removeArtifact('2026-W42', 'error.json');
    await store.removeArtifact('2026-W42', 'error.json');
    return {
      error: await store.readArtifact('2026-W42', 'error.json'),
      digest: await store.readArtifact('2026-W42', 'digest.md'),
    };
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
      removed: await removedArtifact(store),
      remaining: (await store.listRuns()).map((r) => r.runId),
    };
  }

  it('returns the same answers as the in-memory store', async () => {
    const fromDisk = await observe(makeStore());
    const fromMemory = await observe(new MemoryRunStore());
    expect(fromDisk).toEqual(fromMemory);
  });

  async function observeLock(store: RunStore): Promise<unknown> {
    const lock = await store.acquireLock('2026-W42');
    const lostWhileHeld = lock.lost.aborted;
    const second = await store.acquireLock('2026-W43').then(
      () => 'acquired',
      (error: unknown) => (isLockHeldError(error) ? 'held' : 'failed'),
    );
    await lock.release();
    return { lostWhileHeld, second, lostAfterRelease: lock.lost.aborted };
  }

  it('hands out the same lock: held once, lost neither while held nor on release', async () => {
    const fromDisk = await observeLock(makeStore());
    const fromMemory = await observeLock(new MemoryRunStore());
    expect(fromDisk).toEqual({ lostWhileHeld: false, second: 'held', lostAfterRelease: false });
    expect(fromMemory).toEqual(fromDisk);
  });
});

describe('unexpected filesystem errors', () => {
  it('propagate instead of being treated as missing data', async () => {
    const store = makeStore();
    await writeFile(dataDir, 'a file where the data folder should be');

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
