import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { formatDuration, historyCommand, type HistoryCommandDeps } from './history';
import { loadConfig, type LoadedConfig } from '../../config/load';
import { PROFILES } from '../../config/profiles';
import type { RunRecord } from '../../store/runRecord';
import { DigestError } from '../../shared/errors';
import { makeConfig, makeRunRecord } from '../../../test/builders';
import { MemoryRunStore } from '../../../test/fakes';

const DATA_DIR = '/work/data';

interface Harness {
  deps: HistoryCommandDeps;
  out: string[];
  err: string[];
  store: MemoryRunStore;
  loadConfig: Mock<HistoryCommandDeps['loadConfig']>;
  createFsRunStore: Mock<HistoryCommandDeps['createFsRunStore']>;
  listRuns: Mock<MemoryRunStore['listRuns']>;
}

function harness(records: readonly RunRecord[] = []): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const store = new MemoryRunStore();
  records.forEach((record) => store.records.set(record.runId, record));
  const listRuns = vi.spyOn(store, 'listRuns');
  const loaded: LoadedConfig = {
    config: makeConfig({ dataDir: DATA_DIR }),
    env: { OLLAMA_URL: 'http://localhost:11434', LOG_LEVEL: 'info' },
    secrets: {},
    profile: PROFILES.quality,
    platform: { os: 'darwin', arch: 'arm64' },
    configPath: '/work/digest.config.json',
  };
  const loadConfig = vi.fn<HistoryCommandDeps['loadConfig']>(() => Promise.resolve(loaded));
  const createFsRunStore = vi.fn<HistoryCommandDeps['createFsRunStore']>(() => store);
  const deps: HistoryCommandDeps = {
    loadConfig,
    createFsRunStore,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  };
  return { deps, out, err, store, loadConfig, createFsRunStore, listRuns };
}

function run(runId: string, overrides: Partial<RunRecord> = {}): RunRecord {
  return makeRunRecord({ runId, ...overrides });
}

const text = (chunks: readonly string[]): string => chunks.join('');
const lines = (chunks: readonly string[]): string[] => text(chunks).trimEnd().split('\n');

describe('historyCommand: wiring', () => {
  it('opens the run store in the configured data dir and lists the last 12 runs', async () => {
    const h = harness();

    const code = await historyCommand({ config: 'my.config.json' }, h.deps);

    expect(code).toBe(0);
    expect(h.loadConfig).toHaveBeenCalledWith({ configPath: 'my.config.json' });
    expect(h.createFsRunStore).toHaveBeenCalledWith({ dataDir: DATA_DIR });
    expect(h.listRuns).toHaveBeenCalledWith(12);
  });

  it('lists as many runs as -n asks for', async () => {
    const h = harness();

    await historyCommand({ limit: 3 }, h.deps);

    expect(h.listRuns).toHaveBeenCalledWith(3);
  });
});

describe('historyCommand: empty state', () => {
  it('says there are no runs yet and exits 0', async () => {
    const h = harness();

    const code = await historyCommand({}, h.deps);

    expect(code).toBe(0);
    expect(text(h.out)).toBe('No runs yet.\n');
    expect(text(h.err)).toBe('');
  });
});

describe('historyCommand: table', () => {
  const records = [
    run('2026-W42', {
      status: 'sent',
      startedAt: '2026-10-12T05:45:00Z',
      finishedAt: '2026-10-12T05:52:12Z',
      counts: {
        collected: 120,
        afterGuardInput: 118,
        classified: 118,
        selected: 5,
        digestItems: 4,
      },
      winner: 'qwen3.5:27b',
    }),
    run('2026-W41', {
      status: 'quiet',
      startedAt: '2026-10-05T05:45:00Z',
      finishedAt: '2026-10-05T05:45:30Z',
      counts: { collected: 9, afterGuardInput: 9, classified: 9, selected: 0, digestItems: 0 },
      winner: null,
    }),
    run('2026-W40', {
      status: 'dry-run',
      dryRun: true,
      startedAt: '2026-09-28T05:45:00Z',
      finishedAt: '2026-09-28T06:01:05Z',
      counts: {
        collected: 1500,
        afterGuardInput: 1400,
        classified: 1400,
        selected: 5,
        digestItems: 5,
      },
      winner: 'gemma4:31b',
    }),
  ];

  it('marks a variant week with * and explains it under the table only then', async () => {
    const h = harness([
      makeRunRecord({ runId: '2026-W42', variant: { kind: 'enrich' } }),
      makeRunRecord({ runId: '2026-W41' }),
    ]);

    await historyCommand({}, h.deps);

    const rows = lines(h.out);
    expect(rows[1]).toMatch(/^2026-W42\s+sent\*\s/);
    expect(rows[2]).toMatch(/^2026-W41\s+sent\s/);
    expect(rows.at(-1)).toBe('* a variant digest was sent');
    const plain = harness(records);
    await historyCommand({}, plain.deps);
    expect(plain.out.join('')).not.toContain('variant');
  });

  it('prints a header and one row per run, most recent first', async () => {
    const h = harness(records);

    const code = await historyCommand({}, h.deps);

    const rows = lines(h.out);
    expect(code).toBe(0);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatch(/^Week\s+Status\s+Items\s+Duration\s+Winner$/);
    expect(rows[1]).toMatch(/^2026-W42\s+sent\s+120 → 4\s+7m 12s\s+qwen3\.5:27b$/);
    expect(rows[2]).toMatch(/^2026-W41\s+quiet\s+9 → 0\s+30.0s\s+-$/);
    expect(rows[3]).toMatch(/^2026-W40\s+dry-run\s+1500 → 5\s+16m 5s\s+gemma4:31b$/);
  });

  it('aligns every column', async () => {
    const h = harness(records);

    await historyCommand({}, h.deps);

    const rows = lines(h.out);
    const column = (name: string): number => rows[0]?.indexOf(name) ?? -1;
    for (const row of rows.slice(1)) {
      expect(row.indexOf('2026-W')).toBe(0);
      expect(row.slice(column('Status'), column('Items')).trimEnd()).toMatch(
        /^(sent|quiet|dry-run)$/,
      );
      expect(row.slice(column('Items'), column('Duration')).trimEnd()).toMatch(/^\d+ → \d+$/);
    }
  });

  it('shows only the number of runs asked for', async () => {
    const h = harness(records);

    await historyCommand({ limit: 2 }, h.deps);

    const rows = lines(h.out);
    expect(rows).toHaveLength(3);
    expect(text(h.out)).not.toContain('2026-W40');
  });

  it('shows every status the pipeline can record', async () => {
    const statuses = ['sent', 'dry-run', 'skipped', 'quiet', 'blocked', 'failed'] as const;
    const h = harness(statuses.map((status, i) => run(`2026-W${String(10 + i)}`, { status })));

    await historyCommand({}, h.deps);

    for (const status of statuses) expect(text(h.out)).toContain(status);
  });
});

describe('historyCommand: errors', () => {
  it('prints a DigestError on stderr with its exit code', async () => {
    const h = harness();
    h.loadConfig.mockRejectedValue(new DigestError('No digest.config.json found'));

    const code = await historyCommand({}, h.deps);

    expect(code).toBe(1);
    expect(text(h.err)).toBe('No digest.config.json found\n');
    expect(h.createFsRunStore).not.toHaveBeenCalled();
  });

  it('prints any other error on stderr and exits 1', async () => {
    const h = harness();
    h.listRuns.mockRejectedValue(new Error('disk unreadable'));

    const code = await historyCommand({}, h.deps);

    expect(code).toBe(1);
    expect(text(h.err)).toBe('disk unreadable\n');
    expect(text(h.out)).toBe('');
  });
});

describe('formatDuration', () => {
  it.each([
    [0, '0.0s'],
    [7500, '7.5s'],
    [59_949, '59.9s'],
    [60_000, '1m 0s'],
    [432_000, '7m 12s'],
    [3_599_000, '59m 59s'],
    [3_600_000, '1h 0m'],
    [8_130_000, '2h 15m'],
  ])('formats %i ms as %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });

  it('treats a negative span as zero', () => {
    expect(formatDuration(-5)).toBe('0.0s');
  });
});

describe('historyCommand: default dependencies', () => {
  it('reads the real config and run store and writes to the process streams', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'digest-history-'));
    try {
      const configPath = join(dir, 'digest.config.json');
      await writeFile(
        configPath,
        JSON.stringify({
          focusAreas: ['Platform engineering'],
          sources: [{ id: 'example-feed', kind: 'rss', url: 'https://example.com/feed.xml' }],
          schedule: { timeZone: 'Europe/Berlin' },
          dataDir: join(dir, 'data'),
        }),
      );
      const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

      // Keep the real loader hermetic: no ./.env and no process.env from the machine running the tests.
      const hermeticLoad: HistoryCommandDeps['loadConfig'] = (options) =>
        loadConfig({ ...options, envPath: join(dir, '.env'), processEnv: {} });

      const code = await historyCommand({ config: configPath }, { loadConfig: hermeticLoad });

      expect(code).toBe(0);
      expect(stdout).toHaveBeenCalledWith('No runs yet.\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports a missing config on the process stderr', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const code = await historyCommand({ config: join(tmpdir(), 'digest-no-such-dir', 'x.json') });

    expect(code).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('digest init'));
  });
});
