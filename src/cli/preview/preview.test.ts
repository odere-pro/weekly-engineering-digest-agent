import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { previewCommand, type PreviewCommandDeps } from './preview';
import { PROFILES } from '../../config/profiles';
import type { LoadedConfig } from '../../config/load';
import { renderView } from '../../render/markdown';
import { buildDigestView, FALLBACK_NOTE } from '../../render/layout';
import { makeConfig, makeDraft, makeItem, makeRunRecord } from '../../../test/builders';
import { MemoryRunStore } from '../../../test/fakes';

const WEEK = '2026-W42';
/** The default folder: <dataDir>/<monday>/digest/preview, with dataDir `dist` under cwd. */
const previewDir = (): string => join(cwd, 'dist', '2026-10-12', 'digest', 'preview');
const SECRET = 'hunter2-secret-token';

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'preview-'));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

const item = makeItem({ id: 'a', title: 'Picked release' });
const winner = makeDraft([item], 'winner-model');
const loser = makeDraft([makeItem({ title: 'Other' })], 'loser-model');

function harness(
  options: {
    secrets?: LoadedConfig['secrets'];
    ollamaUrl?: string;
    seed?: boolean;
    fallback?: boolean;
  } = {},
) {
  const store = new MemoryRunStore();
  if (options.seed !== false) {
    store.records.set(
      WEEK,
      makeRunRecord({
        runId: WEEK,
        winner: 'winner-model',
        ...(options.fallback === true ? { fallback: true } : {}),
      }),
    );
    store.artifacts.set(`${WEEK}/drafts.json`, JSON.stringify({ drafts: [loser, winner] }));
  }
  const out: string[] = [];
  const err: string[] = [];
  const loaded: LoadedConfig = {
    config: makeConfig({ dataDir: 'dist' }),
    env: { OLLAMA_URL: options.ollamaUrl ?? 'http://localhost:11434', LOG_LEVEL: 'info' },
    secrets: options.secrets ?? {},
    profile: PROFILES.quality,
    platform: { os: 'darwin', arch: 'arm64' },
    configPath: '/work/digest.config.json',
  };
  const deps: PreviewCommandDeps = {
    loadConfig: () => Promise.resolve(loaded),
    createFsRunStore: () => store,
    cwd,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  };
  return { deps, store, out: () => out.join(''), err: () => err.join('') };
}

describe('previewCommand', () => {
  it("writes every channel file into the week's digest folder, preview/, and prints the paths", async () => {
    const h = harness();
    expect(await previewCommand({ week: WEEK }, h.deps)).toBe(0);
    const dir = previewDir();
    expect((await readdir(dir)).sort()).toEqual([
      'digest.md',
      'email.html',
      'email.txt',
      'slack.json',
    ]);
    for (const name of ['digest.md', 'email.html', 'email.txt', 'slack.json']) {
      expect(h.out()).toContain(join(dir, name));
    }
  });

  it('renders the winning draft, not another one', async () => {
    const h = harness();
    await previewCommand({ week: WEEK }, h.deps);
    const dir = previewDir();
    const markdown = await readFile(join(dir, 'digest.md'), 'utf8');
    expect(markdown).toBe(renderView(buildDigestView(winner.digest, { disabledGuards: [] })));
    expect(markdown).toContain('Picked release');
    expect(markdown).not.toContain('Other');
    expect(await readFile(join(dir, 'email.html'), 'utf8')).toContain('<html');
    expect(await readFile(join(dir, 'email.txt'), 'utf8')).toContain('Picked release');
    const slack = JSON.parse(await readFile(join(dir, 'slack.json'), 'utf8')) as {
      blocks: unknown[];
    };
    expect(slack.blocks.length).toBeGreaterThan(0);
  });

  it('shows the fallback footer for a fallback week, and not for a normal one', async () => {
    const fallback = harness({ fallback: true });
    await previewCommand({ week: WEEK, channel: 'markdown' }, fallback.deps);
    const text = await readFile(join(previewDir(), 'digest.md'), 'utf8');
    expect(text).toContain(FALLBACK_NOTE);
    expect(text).toBe(
      renderView(buildDigestView(winner.digest, { disabledGuards: [], fallback: true })),
    );
    const normal = harness();
    await previewCommand({ week: WEEK, channel: 'markdown', out: 'plain' }, normal.deps);
    expect(await readFile(join(cwd, 'plain', WEEK, 'digest.md'), 'utf8')).not.toContain(
      FALLBACK_NOTE,
    );
  });

  it('writes only the chosen channel', async () => {
    const h = harness();
    expect(await previewCommand({ week: WEEK, channel: 'slack' }, h.deps)).toBe(0);
    expect(await readdir(previewDir())).toEqual(['slack.json']);
    const e = harness();
    await previewCommand({ week: WEEK, channel: 'email', out: 'mail' }, e.deps);
    expect((await readdir(join(cwd, 'mail', WEEK))).sort()).toEqual(['email.html', 'email.txt']);
    const m = harness();
    await previewCommand({ week: WEEK, channel: 'markdown', out: 'md' }, m.deps);
    expect(await readdir(join(cwd, 'md', WEEK))).toEqual(['digest.md']);
  });

  it('accepts an absolute --out', async () => {
    const h = harness();
    const out = join(cwd, 'abs');
    expect(await previewCommand({ week: WEEK, channel: 'markdown', out }, h.deps)).toBe(0);
    expect(await readdir(join(out, WEEK))).toEqual(['digest.md']);
  });

  it('shows the guards-off footer from the run record', async () => {
    const h = harness();
    h.store.records.set(
      WEEK,
      makeRunRecord({ runId: WEEK, winner: 'winner-model', disabledGuards: ['graniteRisk'] }),
    );
    await previewCommand({ week: WEEK, channel: 'markdown' }, h.deps);
    const markdown = await readFile(join(previewDir(), 'digest.md'), 'utf8');
    expect(markdown).toContain('graniteRisk');
  });

  it('redacts a known secret from every file', async () => {
    const h = harness({ secrets: { SMTP_PASSWORD: SECRET } });
    const leaky = makeDraft([makeItem({ title: `Key ${SECRET}` })], 'winner-model');
    h.store.artifacts.set(`${WEEK}/drafts.json`, JSON.stringify({ drafts: [leaky] }));
    await previewCommand({ week: WEEK }, h.deps);
    const dir = previewDir();
    for (const name of await readdir(dir)) {
      expect(await readFile(join(dir, name), 'utf8')).not.toContain(SECRET);
    }
  });

  it('redacts the password of OLLAMA_URL from every file', async () => {
    const h = harness({ ollamaUrl: `http://ollama:${SECRET}@gpu-box:11434` });
    const leaky = makeDraft([makeItem({ title: `Key ${SECRET}` })], 'winner-model');
    h.store.artifacts.set(`${WEEK}/drafts.json`, JSON.stringify({ drafts: [leaky] }));
    await previewCommand({ week: WEEK }, h.deps);
    const dir = previewDir();
    const names = await readdir(dir);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(await readFile(join(dir, name), 'utf8')).not.toContain(SECRET);
    }
  });

  it.each([
    [
      'a missing run',
      (h: ReturnType<typeof harness>) => h.store.records.delete(WEEK),
      'No saved run',
    ],
    [
      'missing drafts.json',
      (h: ReturnType<typeof harness>) => h.store.artifacts.delete(`${WEEK}/drafts.json`),
      'drafts.json',
    ],
    [
      'no winner',
      (h: ReturnType<typeof harness>) =>
        h.store.records.set(WEEK, makeRunRecord({ runId: WEEK, winner: null })),
      'no winning draft',
    ],
    [
      'a winner missing from drafts.json',
      (h: ReturnType<typeof harness>) =>
        h.store.records.set(WEEK, makeRunRecord({ runId: WEEK, winner: 'ghost' })),
      'ghost',
    ],
    [
      'invalid drafts.json',
      (h: ReturnType<typeof harness>) => h.store.artifacts.set(`${WEEK}/drafts.json`, '{nope'),
      'drafts.json',
    ],
    [
      'drafts that do not fit the schema',
      (h: ReturnType<typeof harness>) =>
        h.store.artifacts.set(`${WEEK}/drafts.json`, '{"drafts":1}'),
      'drafts.json',
    ],
  ])('exits 1 and writes nothing for %s', async (_name, break_, message) => {
    const h = harness();
    break_(h);
    expect(await previewCommand({ week: WEEK }, h.deps)).toBe(1);
    expect(h.err()).toContain(message);
    await expect(readdir(join(cwd, 'dist'))).rejects.toThrow();
  });

  it('rejects a bad week id and a bad channel', async () => {
    const h = harness();
    expect(await previewCommand({ week: '../x' }, h.deps)).toBe(1);
    expect(h.err()).toContain('ISO week');
    const c = harness();
    expect(await previewCommand({ week: WEEK, channel: 'fax' }, c.deps)).toBe(1);
    expect(c.err()).toContain('markdown, email, slack or all');
  });

  it('exits 1 when the config cannot load', async () => {
    const h = harness();
    h.deps.loadConfig = () => Promise.reject(new Error('no config'));
    expect(await previewCommand({ week: WEEK }, h.deps)).toBe(1);
    expect(h.err()).toContain('no config');
  });
});

describe('previewCommand: hostile text', () => {
  it('redacts a secret with markup characters and drops control codes', async () => {
    const secret = 'a&b<c>"d';
    const h = harness({ secrets: { SMTP_PASSWORD: secret } });
    const leaky = makeDraft([makeItem({ title: `Key ${secret} \u001b[31mred` })], 'winner-model');
    h.store.artifacts.set(`${WEEK}/drafts.json`, JSON.stringify({ drafts: [leaky] }));
    await previewCommand({ week: WEEK }, h.deps);
    const dir = previewDir();
    for (const name of await readdir(dir)) {
      const text = await readFile(join(dir, name), 'utf8');
      expect(text).not.toContain(secret);
      expect(text).not.toContain('\u001b');
    }
  });
});

describe('previewCommand: default wiring', () => {
  it('writes to the process streams and loads the config named by --config', async () => {
    const h = harness();
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      await previewCommand(
        { week: WEEK, channel: 'markdown' },
        { loadConfig: h.deps.loadConfig, createFsRunStore: h.deps.createFsRunStore, cwd },
      );
      expect(String(stdout.mock.calls[0]?.[0])).toContain('digest.md');
      const bad = { week: WEEK, config: '/nonexistent/digest.config.json' };
      expect(await previewCommand(bad)).toBe(1);
      expect(stderr).toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });
});
