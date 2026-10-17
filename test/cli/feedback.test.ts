import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { feedbackCommand, type FeedbackCommandDeps } from '../../src/cli/feedback.js';
import type { LoadedConfig } from '../../src/config/load.js';
import { PROFILES } from '../../src/config/profiles.js';
import { buildReviewSheet } from '../../src/core/reviewSheet.js';
import { makeClassification, makeConfig, makeItem } from '../builders.js';
import { MemoryRunStore } from '../fakes/index.js';

const WEEK = '2026-W42';
const DATA_DIR = '/work/data';

const items = [1, 2, 3, 4].map((n) => makeItem({ id: `f${n}`, title: `Release ${n}` }));
const sheet = buildReviewSheet({
  weekId: WEEK,
  items,
  classifications: items.map((item) => makeClassification(item.id)),
  pickedIds: ['f1', 'f2'],
});
const tick = (text: string, id: string): string =>
  text.replace(`- [ ] \`${id}\``, `- [x] \`${id}\``);

function harness(review: string | null = sheet) {
  const out: string[] = [];
  const err: string[] = [];
  const files = new Map<string, string>();
  const store = new MemoryRunStore();
  if (review !== null) store.artifacts.set(`${WEEK}/review.md`, review);
  const loaded: LoadedConfig = {
    config: makeConfig({ dataDir: DATA_DIR }),
    env: { OLLAMA_URL: 'http://localhost:11434', LOG_LEVEL: 'info' },
    secrets: {},
    profile: PROFILES.quality,
    configPath: '/work/digest.config.json',
  };
  const deps: FeedbackCommandDeps = {
    loadConfig: vi.fn(() => Promise.resolve(loaded)),
    createFsRunStore: vi.fn(() => store),
    mkdir: vi.fn(() => Promise.resolve()),
    writeFile: vi.fn((path: string, content: string) => {
      files.set(path, content);
      return Promise.resolve();
    }),
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  };
  return { deps, out: () => out.join(''), err: () => err.join(''), files };
}

describe('feedbackCommand', () => {
  it('turns a ticked sheet into data/feedback/<week>.json and prints one line', async () => {
    const h = harness(tick(tick(sheet, 'f2'), 'f4'));

    const code = await feedbackCommand({ week: WEEK, config: 'my.json' }, h.deps);

    expect(code).toBe(0);
    expect(JSON.parse(h.files.get(`${DATA_DIR}/feedback/${WEEK}.json`) ?? '')).toEqual({
      weekId: WEEK,
      wrongPicks: ['f2'],
      missed: ['f4'],
    });
    expect(h.deps.mkdir).toHaveBeenCalledWith(`${DATA_DIR}/feedback`);
    expect(h.deps.loadConfig).toHaveBeenCalledWith({ configPath: 'my.json' });
    expect(h.out().trimEnd().split('\n')).toHaveLength(1);
    expect(h.out()).toContain('1 wrong pick, 1 missed');
  });

  it('writes an empty feedback file for an untouched sheet', async () => {
    const h = harness();

    expect(await feedbackCommand({ week: WEEK }, h.deps)).toBe(0);

    expect(h.out()).toContain('0 wrong picks, 0 missed');
  });

  it('exits 1 naming the line of an edited item line, and writes nothing', async () => {
    const h = harness(sheet.replace('- [ ] `f3`', '- [maybe] `f3`'));
    const line = sheet.split('\n').findIndex((l) => l.includes('`f3`')) + 1;

    expect(await feedbackCommand({ week: WEEK }, h.deps)).toBe(1);

    expect(h.err()).toContain(`line ${line}`);
    expect(h.files.size).toBe(0);
  });

  it('exits 1 for a week without a review sheet', async () => {
    const h = harness(null);

    expect(await feedbackCommand({ week: '2026-W10' }, h.deps)).toBe(1);

    expect(h.err()).toContain('2026-W10');
    expect(h.files.size).toBe(0);
  });

  it('exits 1 for a week id that is not an ISO week', async () => {
    const h = harness();

    expect(await feedbackCommand({ week: 'last-week' }, h.deps)).toBe(1);

    expect(h.err()).toContain('last-week');
  });

  it('exits 1 when the sheet belongs to another week', async () => {
    const h = harness(sheet.replaceAll(WEEK, '2026-W41'));

    expect(await feedbackCommand({ week: WEEK }, h.deps)).toBe(1);

    expect(h.err()).toContain('2026-W41');
  });

  it('exits 1 when the file cannot be written', async () => {
    const h = harness();
    vi.mocked(h.deps.writeFile).mockRejectedValue(new Error('disk full'));

    expect(await feedbackCommand({ week: WEEK }, h.deps)).toBe(1);

    expect(h.err()).toContain('disk full');
  });
});

describe('feedbackCommand: default io', () => {
  it('writes the file to disk, prints to stdout and errors to stderr', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'feedback-cmd-'));
    const h = harness();
    vi.mocked(h.deps.loadConfig).mockResolvedValue({
      ...(await h.deps.loadConfig({})),
      config: makeConfig({ dataDir: dir }),
    });
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const { loadConfig, createFsRunStore } = h.deps;

      expect(await feedbackCommand({ week: WEEK }, { loadConfig, createFsRunStore })).toBe(0);
      expect(await feedbackCommand({ week: 'bad' }, { loadConfig, createFsRunStore })).toBe(1);

      const written: unknown = JSON.parse(
        await readFile(join(dir, 'feedback', `${WEEK}.json`), 'utf8'),
      );
      expect(written).toEqual({ weekId: WEEK, wrongPicks: [], missed: [] });
      expect(String(stdout.mock.calls[0]?.[0])).toContain(WEEK);
      expect(String(stderr.mock.calls[0]?.[0])).toContain('bad');
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
