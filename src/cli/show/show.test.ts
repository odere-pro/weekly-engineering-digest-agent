import { describe, expect, it, vi } from 'vitest';
import { showCommand, type ShowCommandDeps } from './show';
import { PROFILES } from '../../config/profiles';
import type { LoadedConfig } from '../../config/load';
import { DigestError } from '../../shared/errors';
import {
  makeClassification,
  makeConfig,
  makeDraft,
  makeItem,
  makeRunRecord,
} from '../../../test/builders';
import { MemoryRunStore } from '../../../test/fakes';

const WEEK = '2026-W42';
const SECRET = 'hunter2-secret-token';

const picked = makeItem({ id: 'a', title: 'Picked release', sourceId: 'feed-a' });
const spare = makeItem({ id: 'b', title: 'Spare release', sourceId: 'feed-b' });
const blocked = makeItem({ id: 'c', title: 'Blocked release', sourceId: 'feed-c' });
const draft = makeDraft([picked]);

const itemsJson = `${JSON.stringify([picked, spare, blocked])}\n`;
const scoresJson = `${JSON.stringify([
  makeClassification('a', { relevance: 3 }),
  makeClassification('b', { relevance: 1 }),
])}\n`;
const draftsJson = JSON.stringify({
  drafts: [draft],
  failures: [{ writer: 'writer-b', error: 'model timed out' }],
  rejections: [
    { writer: 'writer-c', attempt: 1, rejectedBy: ['linkCheck'], problems: ['dead link'] },
  ],
});

function harness(
  options: { seed?: boolean; secrets?: LoadedConfig['secrets']; ollamaUrl?: string } = {},
) {
  const store = new MemoryRunStore();
  if (options.seed !== false) {
    store.records.set(
      WEEK,
      makeRunRecord({
        runId: WEEK,
        winner: 'fake-writer',
        counts: {
          collected: 3,
          afterGuardInput: 2,
          classified: 2,
          selected: 1,
          digestItems: 1,
        },
        drafts: [
          { writer: 'fake-writer', passed: true, rejectedBy: [] },
          { writer: 'writer-c', passed: false, rejectedBy: ['linkCheck'] },
        ],
        failedSources: [{ sourceId: 'feed-x', error: 'HTTP 500' }],
        deliveredTo: ['markdown'],
      }),
    );
    store.artifacts.set(`${WEEK}/items.json`, itemsJson);
    store.artifacts.set(`${WEEK}/scores.json`, scoresJson);
    store.artifacts.set(`${WEEK}/drafts.json`, draftsJson);
    store.artifacts.set(`${WEEK}/digest.md`, '# Week 2026-W42\n\nbody\u001b[31m\n');
    store.artifacts.set(`${WEEK}/review.md`, '# Review\n');
  }
  const out: string[] = [];
  const err: string[] = [];
  const loaded: LoadedConfig = {
    config: makeConfig({ dataDir: '/work/data' }),
    env: { OLLAMA_URL: options.ollamaUrl ?? 'http://localhost:11434', LOG_LEVEL: 'info' },
    secrets: options.secrets ?? {},
    profile: PROFILES.quality,
    platform: { os: 'darwin', arch: 'arm64' },
    configPath: '/work/digest.config.json',
  };
  const deps: ShowCommandDeps = {
    loadConfig: () => Promise.resolve(loaded),
    createFsRunStore: () => store,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  };
  return { deps, store, out: () => out.join(''), err: () => err.join('') };
}

describe('showCommand: summary', () => {
  it('prints status, counts, winner, rejections and failed sources', async () => {
    const h = harness();
    const code = await showCommand({ week: WEEK }, h.deps);
    expect(code).toBe(0);
    const text = h.out();
    expect(text).toContain('2026-W42');
    expect(text).toContain('sent');
    expect(text).toContain('3 collected');
    expect(text).toContain('fake-writer');
    expect(text).toContain('linkCheck');
    expect(text).toContain('feed-x');
    expect(text).toContain('HTTP 500');
    expect(text).toContain('markdown');
  });

  it('shows the error and the disabled guards of a failed run', async () => {
    const h = harness();
    h.store.records.set(
      WEEK,
      makeRunRecord({
        runId: WEEK,
        status: 'failed',
        winner: null,
        disabledGuards: ['graniteRisk'],
        error: { message: 'Every writer failed', step: 'write' },
      }),
    );
    const code = await showCommand({ week: WEEK }, h.deps);
    expect(code).toBe(0);
    expect(h.out()).toContain('Every writer failed');
    expect(h.out()).toContain('graniteRisk');
    expect(h.out()).toContain('none');
  });

  it('strips control and bidi characters from the variant topic', async () => {
    const h = harness();
    h.store.records.set(
      WEEK,
      makeRunRecord({
        runId: WEEK,
        variant: { kind: 'perspective', topic: 'se\u202Ecur\u0007ity' },
      }),
    );
    await showCommand({ week: WEEK }, h.deps);
    expect(h.out()).toContain('Variant:    perspective: security\n');
  });

  it('prints the record as JSON with --json', async () => {
    const h = harness();
    const code = await showCommand({ week: WEEK, json: true }, h.deps);
    expect(code).toBe(0);
    expect(JSON.parse(h.out())).toEqual(h.store.records.get(WEEK));
  });
});

describe('showCommand: parts', () => {
  it('lists items with source, title, date and url', async () => {
    const h = harness();
    expect(await showCommand({ week: WEEK, part: 'items' }, h.deps)).toBe(0);
    expect(h.out()).toContain('Source');
    expect(h.out()).toContain('feed-a');
    expect(h.out()).toContain('Picked release');
    expect(h.out()).toContain('2026-10-12');
    expect(h.out()).toContain(picked.url);
  });

  it('shows scores with what happened to each item', async () => {
    const h = harness();
    expect(await showCommand({ week: WEEK, part: 'scores' }, h.deps)).toBe(0);
    const lines = h.out().split('\n');
    const row = (title: string): string => lines.find((l) => l.includes(title)) ?? '';
    expect(row('Picked release')).toContain('in digest');
    expect(row('Spare release')).toContain('not picked');
    expect(row('Blocked release')).toContain('dropped');
    expect(row('Picked release')).toContain('3.0');
  });

  it('scores without items.json still lists the item ids', async () => {
    const h = harness();
    h.store.artifacts.delete(`${WEEK}/items.json`);
    expect(await showCommand({ week: WEEK, part: 'scores' }, h.deps)).toBe(0);
    expect(h.out()).toContain('a');
    expect(h.out()).toContain('not picked');
  });

  it('shows drafts with writer, passed, rejected by, and the problems', async () => {
    const h = harness();
    expect(await showCommand({ week: WEEK, part: 'drafts' }, h.deps)).toBe(0);
    const text = h.out();
    expect(text).toContain('fake-writer');
    expect(text).toContain('yes');
    expect(text).toContain('linkCheck');
    expect(text).toContain('dead link');
    expect(text).toContain('model timed out');
  });

  it('shows drafts from drafts.json alone when the record has no outcomes', async () => {
    const h = harness();
    h.store.records.set(WEEK, makeRunRecord({ runId: WEEK, drafts: [], winner: null }));
    h.store.artifacts.set(`${WEEK}/drafts.json`, JSON.stringify({ drafts: [draft] }));
    expect(await showCommand({ week: WEEK, part: 'drafts' }, h.deps)).toBe(0);
    expect(h.out()).toContain('fake-writer');
  });

  it('prints the saved Markdown for digest and review without control codes', async () => {
    const h = harness();
    expect(await showCommand({ week: WEEK, part: 'digest' }, h.deps)).toBe(0);
    expect(h.out()).toContain('body');
    expect(h.out()).not.toContain('\u001b');
    const r = harness();
    expect(await showCommand({ week: WEEK, part: 'review' }, r.deps)).toBe(0);
    expect(r.out()).toBe('# Review\n');
  });

  it('prints the record for the run part', async () => {
    const h = harness();
    expect(await showCommand({ week: WEEK, part: 'run' }, h.deps)).toBe(0);
    expect(JSON.parse(h.out())).toEqual(h.store.records.get(WEEK));
  });

  it.each([
    ['items', itemsJson],
    ['scores', scoresJson],
    ['drafts', draftsJson],
  ])('prints %s.json unchanged with --json', async (part, content) => {
    const h = harness();
    expect(await showCommand({ week: WEEK, part, json: true }, h.deps)).toBe(0);
    expect(h.out()).toBe(content);
  });

  it('ends the text of a part with a newline', async () => {
    const h = harness();
    h.store.artifacts.set(`${WEEK}/digest.md`, 'no newline');
    await showCommand({ week: WEEK, part: 'digest' }, h.deps);
    expect(h.out().endsWith('\n')).toBe(true);
  });

  it('redacts a known secret from the printed text', async () => {
    const h = harness({ secrets: { SMTP_PASSWORD: SECRET } });
    h.store.artifacts.set(`${WEEK}/digest.md`, `leaked ${SECRET} here\n`);
    await showCommand({ week: WEEK, part: 'digest' }, h.deps);
    expect(h.out()).not.toContain(SECRET);
  });

  it('redacts the password of OLLAMA_URL from the printed text', async () => {
    const h = harness({ ollamaUrl: `http://ollama:${SECRET}@gpu-box:11434` });
    h.store.artifacts.set(`${WEEK}/digest.md`, `leaked ${SECRET} here\n`);
    await showCommand({ week: WEEK, part: 'digest' }, h.deps);
    expect(h.out()).toContain('leaked');
    expect(h.out()).not.toContain(SECRET);
  });
});

describe('showCommand: failures', () => {
  it('names a missing week and exits 1', async () => {
    const h = harness({ seed: false });
    expect(await showCommand({ week: WEEK }, h.deps)).toBe(1);
    expect(h.err()).toContain('No saved run for 2026-W42');
    expect(h.out()).toBe('');
  });

  it('names a missing part and exits 1', async () => {
    const h = harness();
    h.store.artifacts.delete(`${WEEK}/scores.json`);
    expect(await showCommand({ week: WEEK, part: 'scores' }, h.deps)).toBe(1);
    expect(h.err()).toContain('scores.json');
  });

  it('prints a part whose file exists even when the run has no record', async () => {
    const h = harness();
    h.store.records.delete(WEEK);
    expect(await showCommand({ week: WEEK, part: 'items' }, h.deps)).toBe(0);
    expect(h.out()).toContain('Picked release');
  });

  it('names the run status when the record has no such part', async () => {
    const h = harness();
    h.store.artifacts.delete(`${WEEK}/review.md`);
    expect(await showCommand({ week: WEEK, part: 'review' }, h.deps)).toBe(1);
    expect(h.err()).toBe('Week 2026-W42 has no review.md (run status: sent)\n');
  });

  it('names a missing week when a part is asked for too', async () => {
    const h = harness({ seed: false });
    expect(await showCommand({ week: WEEK, part: 'items' }, h.deps)).toBe(1);
    expect(h.err()).toBe('No saved run for 2026-W42\n');
    expect(h.out()).toBe('');
  });

  it('rejects an unknown part and lists the valid ones', async () => {
    const h = harness();
    expect(await showCommand({ week: WEEK, part: 'nope' }, h.deps)).toBe(1);
    expect(h.err()).toContain('items, scores, drafts, digest, run, review');
  });

  it('rejects a week id that is not an ISO week', async () => {
    const h = harness();
    expect(await showCommand({ week: '../etc' }, h.deps)).toBe(1);
    expect(h.err()).toContain('ISO week');
  });

  it('says which file is unreadable when the JSON is invalid', async () => {
    const h = harness();
    h.store.artifacts.set(`${WEEK}/items.json`, '{nope');
    expect(await showCommand({ week: WEEK, part: 'items' }, h.deps)).toBe(1);
    expect(h.err()).toContain('items.json');
  });

  it('reports a schema mismatch', async () => {
    const h = harness();
    h.store.artifacts.set(`${WEEK}/scores.json`, '[{"itemId": 1}]');
    expect(await showCommand({ week: WEEK, part: 'scores' }, h.deps)).toBe(1);
    expect(h.err()).toContain('scores.json');
  });

  it('exits with the code of a DigestError and 1 for any other error', async () => {
    const h = harness();
    h.deps.loadConfig = () => Promise.reject(new DigestError('bad config'));
    expect(await showCommand({ week: WEEK }, h.deps)).toBe(1);
    expect(h.err()).toContain('bad config');
    h.deps.loadConfig = () => Promise.reject(new Error('boom'));
    expect(await showCommand({ week: WEEK }, h.deps)).toBe(1);
    expect(h.err()).toContain('boom');
  });
});

describe('showCommand: default wiring', () => {
  it('writes to the process streams and loads the config named by --config', async () => {
    const h = harness();
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      await showCommand(
        { week: WEEK },
        { loadConfig: h.deps.loadConfig, createFsRunStore: h.deps.createFsRunStore },
      );
      expect(String(stdout.mock.calls[0]?.[0])).toContain('2026-W42');
      expect(await showCommand({ week: WEEK, config: '/nonexistent/digest.config.json' })).toBe(1);
      expect(stderr).toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });
});

describe('showCommand: --json safety', () => {
  it('redacts secrets and strips control codes even under --json', async () => {
    const h = harness({ secrets: { SMTP_PASSWORD: SECRET } });
    h.store.artifacts.set(`${WEEK}/items.json`, `["${SECRET}\u001b[31m"]\n`);
    await showCommand({ week: WEEK, part: 'items', json: true }, h.deps);
    expect(h.out()).not.toContain(SECRET);
    expect(h.out()).not.toContain('\u001b');
  });
});
