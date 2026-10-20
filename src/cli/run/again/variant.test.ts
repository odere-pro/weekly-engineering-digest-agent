import { describe, expect, it } from 'vitest';
import type { LoadedConfig } from '../../../config/load';
import type { RunRecord } from '../../../store/runRecord';
import { makeItem, makeRunRecord } from '../../../../test/builders';
import { MemoryRunStore } from '../../../../test/fakes';
import { scriptedPrompts, type Rule } from '../../init/__fixtures__/initHarness';
import { harness } from '../__fixtures__/runHarness';
import { linkUrls } from './links';
import type { AgainFlags } from './types';
import { variantPlan } from './variant';

const WEEK = '2026-W43';
const items = [
  makeItem({ url: 'https://example.com/a' }),
  makeItem({ url: 'https://example.com/b' }),
];
const sentRecord = makeRunRecord({ runId: WEEK, sentUrls: ['https://example.com/a'] });

function setup(options: { record?: typeof sentRecord; digest?: string; saved?: boolean } = {}): {
  store: MemoryRunStore;
  loaded: LoadedConfig;
  previous: RunRecord | undefined;
} {
  const store = new MemoryRunStore();
  if (options.saved !== false) store.artifacts.set(`${WEEK}/items.json`, JSON.stringify(items));
  if (options.digest !== undefined) store.artifacts.set(`${WEEK}/digest.md`, options.digest);
  const { loaded } = harness();
  return { store, loaded, previous: options.record ?? sentRecord };
}

function plan(
  kind: Parameters<typeof variantPlan>[0],
  env: ReturnType<typeof setup>,
  flags: AgainFlags = {},
  rules: readonly Rule[] = [],
) {
  const { prompts } = scriptedPrompts(rules);
  return variantPlan(kind, { ...env, weekId: WEEK, prompts, flags });
}

describe('variantPlan', () => {
  it('enrich: reuses the saved items, fetches every source, keeps the sent URLs', async () => {
    const result = await plan('enrich', setup());

    expect(result.reuse).toEqual({ items });
    expect(result.variant).toEqual({ kind: 'enrich', keepUrls: ['https://example.com/a'] });
    expect(result.added).toEqual([]);
  });

  it('complete: fetches nothing', async () => {
    const result = await plan('complete', setup());

    expect(result.reuse).toEqual({ items, fetchSourceIds: [] });
    expect(result.variant.kind).toBe('complete');
  });

  it('perspective: asks for the topic and fetches nothing', async () => {
    const result = await plan('perspective', setup(), {}, [[/perspective/, 'AI and LLM updates']]);

    expect(result.reuse.fetchSourceIds).toEqual([]);
    expect(result.variant).toMatchObject({ kind: 'perspective', topic: 'AI and LLM updates' });
  });

  it('perspective: takes a flag topic cleaned, without asking', async () => {
    const result = await plan('perspective', setup(), { perspective: ' "security" ' });

    expect(result.variant.topic).toBe('security');
  });

  it('perspective: refuses a flag topic with nothing left', async () => {
    await expect(plan('perspective', setup(), { perspective: '""' })).rejects.toThrow(
      /Invalid --perspective/,
    );
  });

  it('add-sources: fetches only the new ids, with the sources added to the config', async () => {
    const env = setup();
    const result = await plan('add-sources', env, {}, [
      [/Source URLs/, 'https://new.example.com/feed'],
    ]);

    expect(result.reuse.fetchSourceIds).toEqual(['new-example-com-feed']);
    expect(result.variant.addedSources).toEqual(['new-example-com-feed']);
    expect(result.loaded.config.sources.map((s) => s.id)).toEqual([
      'example-feed',
      'new-example-com-feed',
    ]);
    expect(env.loaded.config.sources).toHaveLength(1);
    expect(result.added).toHaveLength(1);
  });

  it('add-sources: takes the URLs from the flag without asking', async () => {
    const result = await plan('add-sources', setup(), {
      addSource: ['https://github.com/acme/widgets', 'https://new.example.com/feed'],
    });

    expect(result.added.map((s) => s.kind)).toEqual(['github', 'rss']);
  });

  it('add-sources: a bad flag URL stops before anything is fetched', async () => {
    await expect(plan('add-sources', setup(), { addSource: ['nope'] })).rejects.toThrow(
      /Invalid --add-source/,
    );
  });

  it('keepUrls fall back to the links in the saved digest.md when nothing was sent', async () => {
    const env = setup({
      record: makeRunRecord({ runId: WEEK, status: 'dry-run', sentUrls: [] }),
      digest: '# D\n- [A](https://example.com/a) and [B](https://example.com/b)\n',
    });

    const result = await plan('enrich', env);

    expect(result.variant.keepUrls).toEqual(['https://example.com/a', 'https://example.com/b']);
  });

  it('keepUrls are empty without a record or a digest.md', async () => {
    const env = { ...setup(), previous: undefined };

    expect((await plan('enrich', env)).variant.keepUrls).toEqual([]);
  });

  it('names the week when items.json is missing', async () => {
    await expect(plan('enrich', setup({ saved: false }))).rejects.toThrow(
      'No saved items for 2026-W43; run it once without a variant first.',
    );
  });

  it('names the week when items.json cannot be read', async () => {
    const env = setup();
    env.store.artifacts.set(`${WEEK}/items.json`, '{"not":"a list"}');

    await expect(plan('enrich', env)).rejects.toThrow(/saved items for 2026-W43 cannot be read/);
  });
});

describe('linkUrls', () => {
  it('is empty for text with no links', () => {
    expect(linkUrls('no links, only https://x.io/bare')).toEqual([]);
  });

  it('lists each Markdown link URL once, in order', () => {
    expect(linkUrls('[a](https://x.io/1) [b](https://x.io/2) [c](https://x.io/1) (no)')).toEqual([
      'https://x.io/1',
      'https://x.io/2',
    ]);
  });
});
