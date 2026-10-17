import { describe, expect, it } from 'vitest';
import { processStep, type ProcessInput } from '../../../src/core/steps/process.js';
import { ThresholdsSchema } from '../../../src/config/schema.js';
import type { Classification, Item, ScoredItem } from '../../../src/core/schemas.js';
import { DigestError } from '../../../src/shared/errors.js';
import { makeScoredItem } from '../../builders.js';

const thresholds = ThresholdsSchema.parse({});

function scored(
  id: string,
  classification: Partial<Classification> = {},
  item: Partial<Item> = {},
): ScoredItem {
  return makeScoredItem({ id, ...item }, classification);
}

function run(items: readonly ScoredItem[], overrides: Partial<ProcessInput> = {}) {
  return processStep({
    items,
    sentUrls: new Set<string>(),
    thresholds,
    topN: 5,
    ...overrides,
  });
}

const ids = (items: readonly ScoredItem[]): string[] => items.map((item) => item.id);

describe('processStep drop reasons', () => {
  it('keeps clean items and reports nothing dropped', () => {
    const out = run([scored('a'), scored('b')]);

    expect(ids(out.selected).sort()).toEqual(['a', 'b']);
    expect(out.dropped).toEqual([]);
  });

  it('drops low-relevance items below minRelevance but keeps those at the threshold', () => {
    const out = run([
      scored('low', { relevance: thresholds.minRelevance - 0.1 }),
      scored('edge', { relevance: thresholds.minRelevance }),
    ]);

    expect(ids(out.selected)).toEqual(['edge']);
    expect(out.dropped).toEqual([{ itemId: 'low', reason: 'low-relevance' }]);
  });

  it('drops hype above maxHype but keeps hype at the threshold', () => {
    const out = run([
      scored('hyped', { hype: thresholds.maxHype + 0.1 }),
      scored('edge', { hype: thresholds.maxHype }),
    ]);

    expect(ids(out.selected)).toEqual(['edge']);
    expect(out.dropped).toEqual([{ itemId: 'hyped', reason: 'hype' }]);
  });

  it('drops minor releases above maxMinorRelease but keeps those at the threshold', () => {
    const out = run([
      scored('patch', { minorRelease: thresholds.maxMinorRelease + 0.1 }),
      scored('edge', { minorRelease: thresholds.maxMinorRelease }),
    ]);

    expect(ids(out.selected)).toEqual(['edge']);
    expect(out.dropped).toEqual([{ itemId: 'patch', reason: 'minor-release' }]);
  });

  it('uses thresholds from the input, not built-in constants', () => {
    const strict = { ...thresholds, minRelevance: 2.9, maxHype: 0.05, maxMinorRelease: 0.05 };
    const out = run(
      [
        scored('ok', { relevance: 3, hype: 0, minorRelease: 0 }),
        scored('meh', { relevance: 2.5 }),
        scored('hype', { relevance: 3, hype: 0.1, minorRelease: 0 }),
        scored('minor', { relevance: 3, hype: 0, minorRelease: 0.1 }),
      ],
      { thresholds: strict },
    );

    expect(ids(out.selected)).toEqual(['ok']);
    expect(out.dropped).toEqual([
      { itemId: 'meh', reason: 'low-relevance' },
      { itemId: 'hype', reason: 'hype' },
      { itemId: 'minor', reason: 'minor-release' },
    ]);
  });

  it('reports one reason per item, in the documented order', () => {
    const everything = scored(
      'x',
      { relevance: 0, hype: 1, minorRelease: 1 },
      { url: 'https://example.com/sent' },
    );
    const hypeAndMinor = scored('y', { hype: 1, minorRelease: 1 });
    const lowAndHype = scored('z', { relevance: 0, hype: 1 });

    const out = run([everything, hypeAndMinor, lowAndHype], {
      sentUrls: new Set(['https://example.com/sent']),
    });

    expect(out.selected).toEqual([]);
    expect(out.dropped).toEqual([
      { itemId: 'x', reason: 'sent-before' },
      { itemId: 'z', reason: 'low-relevance' },
      { itemId: 'y', reason: 'hype' },
    ]);
  });
});

describe('processStep sent-before', () => {
  it('drops items whose URL was sent in a recent week', () => {
    const sent = scored('sent', {}, { url: 'https://example.com/posts/sent' });
    const fresh = scored('fresh', {}, { url: 'https://example.com/posts/fresh' });

    const out = run([sent, fresh], { sentUrls: new Set(['https://example.com/posts/sent']) });

    expect(ids(out.selected)).toEqual(['fresh']);
    expect(out.dropped).toEqual([{ itemId: 'sent', reason: 'sent-before' }]);
  });

  it('matches through URL normalization (utm params, fragment, trailing slash, host case)', () => {
    const item = scored(
      'tracked',
      {},
      { url: 'https://Example.com/posts/launch/?utm_source=rss&utm_medium=feed#intro' },
    );

    const out = run([item], { sentUrls: new Set(['https://example.com/posts/launch']) });

    expect(out.selected).toEqual([]);
    expect(out.dropped).toEqual([{ itemId: 'tracked', reason: 'sent-before' }]);
  });

  it('normalizes the sent URLs too, so a tracked URL in the run record still matches', () => {
    const item = scored('clean', {}, { url: 'https://example.com/posts/launch' });

    const out = run([item], {
      sentUrls: new Set(['https://example.com/posts/launch?utm_campaign=weekly']),
    });

    expect(out.dropped).toEqual([{ itemId: 'clean', reason: 'sent-before' }]);
  });

  it('does not treat a different path or query as sent', () => {
    const item = scored('other', {}, { url: 'https://example.com/posts/launch?page=2' });

    const out = run([item], { sentUrls: new Set(['https://example.com/posts/launch']) });

    expect(ids(out.selected)).toEqual(['other']);
  });
});

describe('processStep duplicates', () => {
  it('keeps the higher-relevance item when two share an id', () => {
    const weak = scored('same', { relevance: 2 }, { url: 'https://example.com/a' });
    const strong = scored('same', { relevance: 3 }, { url: 'https://example.com/b' });

    const out = run([weak, strong]);

    expect(out.selected).toEqual([strong]);
    expect(out.dropped).toEqual([{ itemId: 'same', reason: 'duplicate' }]);
  });

  it('keeps the higher-relevance item when two sources share a normalized title', () => {
    const blog = scored(
      'blog',
      { relevance: 2.2 },
      { sourceId: 'blog', title: 'Kubernetes 1.34 is out!' },
    );
    const news = scored(
      'news',
      { relevance: 2.8 },
      { sourceId: 'news', title: '  kubernetes   1.34 is OUT ' },
    );

    const out = run([blog, news]);

    expect(ids(out.selected)).toEqual(['news']);
    expect(out.dropped).toEqual([{ itemId: 'blog', reason: 'duplicate' }]);
  });

  it('settles a full tie between items sharing an id by source, whatever the input order', () => {
    const fromA = scored('same', {}, { sourceId: 'a-feed' });
    const fromB = scored('same', {}, { sourceId: 'b-feed' });

    expect(run([fromA, fromB]).selected).toEqual([fromA]);
    expect(run([fromB, fromA]).selected).toEqual([fromA]);
  });

  it('settles ties between same-id, same-source items by title, then URL', () => {
    const byTitleA = scored('same', {}, { title: 'Alpha', url: 'https://example.com/2' });
    const byTitleB = scored('same', {}, { title: 'Beta', url: 'https://example.com/1' });
    const byUrlA = scored('other', {}, { title: 'Gamma', url: 'https://example.com/3' });
    const byUrlB = scored('other', {}, { title: 'Gamma', url: 'https://example.com/4' });

    const forward = run([byTitleB, byTitleA, byUrlB, byUrlA]);
    const backward = run([byUrlA, byUrlB, byTitleA, byTitleB]);

    expect(forward.selected).toEqual([byUrlA, byTitleA]);
    expect(backward.selected).toEqual([byUrlA, byTitleA]);
  });

  it('does not merge items with the same title from the same source', () => {
    const first = scored('one', {}, { sourceId: 'feed', title: 'Weekly update' });
    const second = scored('two', {}, { sourceId: 'feed', title: 'Weekly update' });

    const out = run([first, second]);

    expect(ids(out.selected).sort()).toEqual(['one', 'two']);
    expect(out.dropped).toEqual([]);
  });

  it('never treats blank titles as duplicates', () => {
    const first = scored('one', {}, { sourceId: 'a', title: '   ' });
    const second = scored('two', {}, { sourceId: 'b', title: '' });

    const out = run([first, second]);

    expect(ids(out.selected).sort()).toEqual(['one', 'two']);
  });

  it('breaks a relevance tie by areaConfidence, then by id', () => {
    const lessSure = scored(
      'a',
      { relevance: 2.5, areaConfidence: 0.5 },
      { sourceId: 's1', title: 'Same story' },
    );
    const moreSure = scored(
      'b',
      { relevance: 2.5, areaConfidence: 0.9 },
      { sourceId: 's2', title: 'Same story' },
    );
    const tieA = scored('c', {}, { sourceId: 's3', title: 'Another story' });
    const tieB = scored('d', {}, { sourceId: 's4', title: 'Another story' });

    const out = run([lessSure, moreSure, tieB, tieA]);

    expect(ids(out.selected)).toEqual(['b', 'c']);
    expect(out.dropped).toEqual([
      { itemId: 'd', reason: 'duplicate' },
      { itemId: 'a', reason: 'duplicate' },
    ]);
  });

  it('collapses a chain of duplicates down to the best item', () => {
    const a = scored('a', { relevance: 2 }, { sourceId: 's1', title: 'Big launch' });
    const b = scored('b', { relevance: 3 }, { sourceId: 's2', title: 'Big launch' });
    const c = scored('c', { relevance: 2.5 }, { sourceId: 's3', title: 'big launch' });

    const out = run([a, b, c]);

    expect(ids(out.selected)).toEqual(['b']);
    expect(out.dropped).toEqual([
      { itemId: 'c', reason: 'duplicate' },
      { itemId: 'a', reason: 'duplicate' },
    ]);
  });

  it('runs before the threshold filters, so a filtered winner takes its story with it', () => {
    const winner = scored('w', { relevance: 3, hype: 0.9 }, { sourceId: 's1', title: 'A story' });
    const loser = scored('l', { relevance: 2, hype: 0.1 }, { sourceId: 's2', title: 'A story' });

    const out = run([winner, loser]);

    expect(out.selected).toEqual([]);
    expect(out.dropped).toEqual([
      { itemId: 'l', reason: 'duplicate' },
      { itemId: 'w', reason: 'hype' },
    ]);
  });

  it('folds Unicode forms when comparing titles', () => {
    const plain = scored('a', { relevance: 2 }, { sourceId: 's1', title: 'Kubernetes 1.34 live' });
    const wide = scored(
      'b',
      { relevance: 3 },
      {
        sourceId: 's2',
        title:
          '\uFF2B\uFF55\uFF42\uFF45\uFF52\uFF4E\uFF45\uFF54\uFF45\uFF53 \uFF11\uFF0E\uFF13\uFF14 live',
      },
    );

    const out = run([plain, wide]);

    expect(ids(out.selected)).toEqual(['b']);
    expect(out.dropped).toEqual([{ itemId: 'a', reason: 'duplicate' }]);
  });

  it('keeps titles apart when they differ only in non-ASCII letters or in + and #', () => {
    const out = run([
      scored('a', {}, { sourceId: 's1', title: 'Gr\u00F6\u00DFe 2 released' }),
      scored('b', {}, { sourceId: 's2', title: 'Gr\u00FC\u00DFe 2 released' }),
      scored('c', {}, { sourceId: 's3', title: 'C++ 23 released' }),
      scored('d', {}, { sourceId: 's4', title: 'C# 23 released' }),
    ]);

    expect(ids(out.selected)).toEqual(['a', 'b', 'c', 'd']);
    expect(out.dropped).toEqual([]);
  });

  it('runs after sent-before, so a sent copy does not hide a fresh one', () => {
    const sent = scored(
      'sent',
      { relevance: 3 },
      { sourceId: 's1', title: 'Same', url: 'https://example.com/sent' },
    );
    const fresh = scored(
      'fresh',
      { relevance: 2 },
      { sourceId: 's2', title: 'Same', url: 'https://example.com/fresh' },
    );

    const out = run([sent, fresh], { sentUrls: new Set(['https://example.com/sent']) });

    expect(ids(out.selected)).toEqual(['fresh']);
    expect(out.dropped).toEqual([{ itemId: 'sent', reason: 'sent-before' }]);
  });
});

describe('processStep same release in different sources (F5)', () => {
  const release = (id: string, sourceId: string, title: string, relevance = 2.5): ScoredItem =>
    scored(id, { relevance }, { sourceId, title });

  it('keeps one entry when two sources announce the same product and version (Muse Spark Open)', () => {
    const hub = release(
      'hub',
      'huggingface-blog',
      'Muse Spark Open 1.0 is now on Hugging Face',
      2.4,
    );
    const aws = release(
      'aws',
      'aws-whats-new',
      'Announcing Muse Spark Open v1.0 on Amazon SageMaker JumpStart',
      2.9,
    );

    const out = run([hub, aws]);

    expect(ids(out.selected)).toEqual(['aws']);
    expect(out.dropped).toEqual([{ itemId: 'hub', reason: 'duplicate' }]);
  });

  it('keeps the highest-scored one whatever the input order', () => {
    const low = release('low', 'blog-a', 'Muse Spark Open 1.0 arrives', 2.1);
    const high = release('high', 'blog-b', 'Muse Spark Open 1.0 now available', 2.8);

    expect(ids(run([low, high]).selected)).toEqual(['high']);
    expect(ids(run([high, low]).selected)).toEqual(['high']);
  });

  it('collapses three sources to the best one', () => {
    const out = run([
      release('a', 's1', 'Kubernetes 1.34 is out', 2.2),
      release('b', 's2', 'Kubernetes v1.34: Of Wind & Will', 2.9),
      release('c', 's3', 'Introducing Kubernetes 1.34', 2.5),
    ]);

    expect(ids(out.selected)).toEqual(['b']);
    expect(out.dropped).toEqual([
      { itemId: 'c', reason: 'duplicate' },
      { itemId: 'a', reason: 'duplicate' },
    ]);
  });

  it('matches a GitHub release title against a blog post for the same tag', () => {
    const github = release(
      'gh',
      'transformers-releases',
      'transformers v5.20.0: Release v5.20.0',
      2.3,
    );
    const blog = release('blog', 'huggingface-blog', 'Transformers 5.20.0 is out', 2.7);

    const out = run([github, blog]);

    expect(ids(out.selected)).toEqual(['blog']);
    expect(out.dropped).toEqual([{ itemId: 'gh', reason: 'duplicate' }]);
  });

  it('treats a trailing .0 as the same version', () => {
    const tag = release('tag', 'ollama-releases', 'ollama v0.12.0', 2.2);
    const post = release('post', 'ollama-blog', 'Ollama 0.12 is out', 2.6);

    expect(ids(run([tag, post]).selected)).toEqual(['post']);
  });

  it('folds Unicode forms and punctuation in the product name', () => {
    const plain = release('plain', 's1', 'Claude Code 2.1.5 released', 2.2);
    const dashed = release('dashed', 's2', '\uFF43laude-code v2.1.5', 2.6);

    expect(ids(run([plain, dashed]).selected)).toEqual(['dashed']);
  });

  it.each([
    ['another version of the same product', 'Kubernetes 1.34 is out', 'Kubernetes 1.35 is out'],
    ['another product with the same version', 'Alpha 2.0 is out', 'Beta 2.0 is out'],
    ['a prerelease of the same version', 'Tool 1.2.0-rc1 is out', 'Tool 1.2.0 is out'],
    ['a patch release', 'Tool 1.2 is out', 'Tool 1.2.1 is out'],
    ['a different prefix before the product', 'Meta Muse Spark Open 1.0', 'Muse Spark Open 1.0'],
  ])('keeps both for %s', (_name, first, second) => {
    const out = run([release('one', 's1', first), release('two', 's2', second)]);

    expect(ids(out.selected).sort()).toEqual(['one', 'two']);
    expect(out.dropped).toEqual([]);
  });

  it.each([
    ['model variants', 'Claude 3.5 Sonnet', 'Claude 3.5 Haiku'],
    [
      'model variants after an announcement',
      'Gemini 2.5 Pro is generally available',
      'Gemini 2.5 Flash-Lite is now in preview',
    ],
    ['model sizes', 'Llama 3.1 405B', 'Llama 3.1 8B'],
    ['model sizes with a hyphenated name', 'GPT-4.1 mini', 'GPT-4.1 nano'],
    ['model specializations', 'Qwen 2.5 Coder', 'Qwen 2.5 VL'],
    ['support in two libraries', 'Python 3.13 support in numpy', 'Python 3.13 support in pandas'],
    [
      'release notes and a security advisory',
      'Kubernetes 1.34 release notes',
      'Kubernetes 1.34 security advisory',
    ],
    ['a migration guide and the release', 'Foo 1.2 to 1.3 migration guide', 'Foo 1.2 released'],
    [
      'the release and a benchmark against another version',
      'Postgres 17.1',
      'Postgres 17.1 vs 16.5 benchmark',
    ],
    [
      'a version heading and a different product',
      'Whats new in 2.0 for LangChain',
      'Whats new in 2.0 for LlamaIndex',
    ],
  ])('keeps both for %s sharing a prefix and version (%s / %s)', (_name, first, second) => {
    const out = run([release('one', 's1', first), release('two', 's2', second)]);

    expect(ids(out.selected).sort()).toEqual(['one', 'two']);
    expect(out.dropped).toEqual([]);
  });

  it('ignores a title that names a second version, such as an upgrade path', () => {
    const out = run([
      release('one', 's1', 'Foo 1.2 is out, replacing 1.1'),
      release('two', 's2', 'Foo 1.2 is out'),
    ]);

    expect(ids(out.selected).sort()).toEqual(['one', 'two']);
  });

  it.each([
    ['nothing after the version', 'Tool 6.1', 'Tool 6.1 is out'],
    ['an announcement verb', 'Tool 6.1 ships today', 'Tool 6.1 released'],
    ['a subtitle after a colon', 'Tool 6.1: Fast Lane', 'Tool 6.1 is available'],
    ['a subtitle after a dash', 'Tool 6.1 - Fast Lane', 'Tool 6.1 is available'],
    ['only punctuation after the version', 'Tool 6.1.', 'Tool 6.1 is available'],
    ['a platform the release landed on', 'Tool 6.1 on Platform A', 'Tool 6.1 now in Platform B'],
    ['the same version repeated in a subtitle', 'tool v6.1.0: Release v6.1.0', 'Tool 6.1 is out'],
  ])('merges when the title has %s', (_name, first, second) => {
    const out = run([release('one', 's1', first, 2.2), release('two', 's2', second, 2.8)]);

    expect(ids(out.selected)).toEqual(['two']);
    expect(out.dropped).toEqual([{ itemId: 'one', reason: 'duplicate' }]);
  });

  it('does not read a version out of text that only starts like one', () => {
    const out = run([
      release('one', 's1', 'Tool 1.2.3abc is out'),
      release('two', 's2', 'Tool 1.2.3abc ships'),
    ]);

    expect(ids(out.selected).sort()).toEqual(['one', 'two']);
  });

  it('stays fast on hostile titles', () => {
    const hostile = [
      `Tool ${'1.'.repeat(50_000)}x is out`,
      `Tool 1.2${'-'.repeat(50_000)}`,
      `Tool 1${'.0'.repeat(50_000)} is out`,
      `${'v1.2 '.repeat(20_000)}is out`,
    ];
    const started = performance.now();

    run(hostile.map((title, i) => release(`h${i}`, `s${i}`, title)));

    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('does not merge on a shared name without a version token', () => {
    const out = run([
      release('hub', 's1', 'Muse Spark Open lands on Hugging Face'),
      release('aws', 's2', 'Muse Spark Open now available on Amazon SageMaker JumpStart'),
    ]);

    expect(ids(out.selected).sort()).toEqual(['aws', 'hub']);
  });

  it('leaves the original smoke pair to the writer: no version in the cloud post', () => {
    const out = run([
      release('gh', 'transformers-releases', 'transformers v5.20.0: Release v5.20.0'),
      release(
        'aws',
        'aws-whats-new',
        'Muse Spark Open model now available on Amazon SageMaker JumpStart',
      ),
    ]);

    expect(ids(out.selected).sort()).toEqual(['aws', 'gh']);
  });

  it('does not merge two items of the same source', () => {
    const out = run([
      release('one', 'feed', 'Tool 3.1 is out'),
      release('two', 'feed', 'Tool 3.1 migration guide'),
    ]);

    expect(ids(out.selected).sort()).toEqual(['one', 'two']);
  });

  it.each([
    ['a title that is only a version', 'v1.2.0', 'Release 1.2.0'],
    ['a version with filler words only', 'Version 2.0', 'New 2.0'],
    ['plain integers and years', 'Python 3 turns 2026', 'Python 3 turns 2026 again'],
  ])('has no release key for %s', (_name, first, second) => {
    const out = run([release('one', 's1', first), release('two', 's2', second)]);

    expect(ids(out.selected).sort()).toEqual(['one', 'two']);
  });

  it('does not read a version out of a longer word or number', () => {
    const out = run([
      release('one', 's1', 'Tool build1.2.3 notes'),
      release('two', 's2', 'Tool build1.2.3 changes'),
    ]);

    expect(ids(out.selected).sort()).toEqual(['one', 'two']);
  });

  it('runs after sent-before, so a sent copy does not hide a fresh one', () => {
    const sent = scored(
      'sent',
      { relevance: 3 },
      { sourceId: 's1', title: 'Tool 4.0 is out', url: 'https://example.com/sent' },
    );
    const fresh = release('fresh', 's2', 'Tool v4.0 released', 2);

    const out = run([sent, fresh], { sentUrls: new Set(['https://example.com/sent']) });

    expect(ids(out.selected)).toEqual(['fresh']);
    expect(out.dropped).toEqual([{ itemId: 'sent', reason: 'sent-before' }]);
  });

  it('does not modify its input', () => {
    const items = Object.freeze([
      Object.freeze(release('a', 's1', 'Tool 5.0 is out')),
      Object.freeze(release('b', 's2', 'Tool 5.0 ships')),
    ]);
    const snapshot = structuredClone(items);

    run(items);

    expect(items).toEqual(snapshot);
  });
});

describe('processStep ranking', () => {
  it('ranks by relevance descending', () => {
    const out = run([
      scored('low', { relevance: 2 }, { sourceId: 's1' }),
      scored('top', { relevance: 3 }, { sourceId: 's2' }),
      scored('mid', { relevance: 2.5 }, { sourceId: 's3' }),
    ]);

    expect(ids(out.selected)).toEqual(['top', 'mid', 'low']);
  });

  it('breaks relevance ties by areaConfidence descending', () => {
    const out = run([
      scored('a-unsure', { relevance: 2.5, areaConfidence: 0.6 }),
      scored('z-sure', { relevance: 2.5, areaConfidence: 0.95 }),
    ]);

    expect(ids(out.selected)).toEqual(['z-sure', 'a-unsure']);
  });

  it('breaks remaining ties by publishedAt descending, comparing instants not strings', () => {
    const out = run([
      scored('older', {}, { publishedAt: '2026-10-10T09:00:00Z' }),
      // 2026-10-12T08:00Z, but sorts after the others as a plain string
      scored('newest', {}, { publishedAt: '2026-10-12T10:00:00+02:00' }),
      scored('middle', {}, { publishedAt: '2026-10-11T09:00:00Z' }),
    ]);

    expect(ids(out.selected)).toEqual(['newest', 'middle', 'older']);
  });

  it('ranks an unparseable publishedAt as the oldest instead of failing', () => {
    const out = run([
      scored('broken', {}, { publishedAt: 'not-a-date' }),
      scored('dated', {}, { publishedAt: '2026-10-10T09:00:00Z' }),
    ]);

    expect(ids(out.selected)).toEqual(['dated', 'broken']);
  });

  it('breaks full ties by id ascending, whatever the input order', () => {
    const shared = { publishedAt: '2026-10-12T09:00:00Z' };
    const out = run([scored('c', {}, shared), scored('a', {}, shared), scored('b', {}, shared)]);

    expect(ids(out.selected)).toEqual(['a', 'b', 'c']);
  });
});

describe('processStep top N', () => {
  const many = (): ScoredItem[] =>
    ['a', 'b', 'c', 'd', 'e'].map((id, index) =>
      scored(id, { relevance: 3 - index * 0.2, area: `area-${id}` }),
    );

  it('keeps topN and reports the rest as below-top-n in rank order', () => {
    const out = run(many(), { topN: 3 });

    expect(ids(out.selected)).toEqual(['a', 'b', 'c']);
    expect(out.dropped).toEqual([
      { itemId: 'd', reason: 'below-top-n' },
      { itemId: 'e', reason: 'below-top-n' },
    ]);
  });

  it('allows fewer than topN, and an empty result', () => {
    expect(run([scored('only')], { topN: 5 }).selected).toHaveLength(1);
    expect(run([], { topN: 5 })).toEqual({ selected: [], dropped: [] });
  });

  it('selects nothing when topN is 0', () => {
    const out = run(many(), { topN: 0 });

    expect(out.selected).toEqual([]);
    expect(out.dropped.map((d) => d.reason)).toEqual(Array(5).fill('below-top-n'));
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects topN %s', (topN) => {
    expect(() => run(many(), { topN })).toThrow(DigestError);
  });
});

describe('processStep exact pick (W7-03)', () => {
  it('returns exactly topN items when more survive, tied items in publishedAt then id order', () => {
    const items = ['e', 'd', 'c', 'b', 'a'].map((id, index) =>
      scored(
        id,
        { area: `area-${id}` },
        { publishedAt: index < 2 ? '2026-10-12T09:00:00Z' : '2026-10-10T09:00:00Z' },
      ),
    );

    const first = run(items, { topN: 4 });
    const second = run([...items].reverse(), { topN: 4 });

    expect(ids(first.selected)).toEqual(['d', 'e', 'a', 'b']);
    expect(ids(second.selected)).toEqual(ids(first.selected));
  });
});

describe('processStep area spread', () => {
  const inArea = (id: string, relevance: number, area: string): ScoredItem =>
    scored(id, { relevance, area });

  it('lets an area take at most 2 slots while another area has an eligible item', () => {
    const out = run(
      [
        inArea('ai-1', 3, 'AI'),
        inArea('ai-2', 2.9, 'AI'),
        inArea('ai-3', 2.8, 'AI'),
        inArea('plat-1', 2.0, 'Platform'),
      ],
      { topN: 3 },
    );

    expect(ids(out.selected)).toEqual(['ai-1', 'ai-2', 'plat-1']);
    expect(out.dropped).toEqual([{ itemId: 'ai-3', reason: 'below-top-n' }]);
  });

  it('fills the remaining slots from a capped area when no other area has an item', () => {
    const out = run(
      [inArea('ai-1', 3, 'AI'), inArea('ai-2', 2.9, 'AI'), inArea('ai-3', 2.8, 'AI')],
      { topN: 3 },
    );

    expect(ids(out.selected)).toEqual(['ai-1', 'ai-2', 'ai-3']);
  });

  it('spreads to lower-ranked areas first, then lists the selection in rank order', () => {
    const out = run(
      [
        inArea('ai-1', 3, 'AI'),
        inArea('ai-2', 2.9, 'AI'),
        inArea('ai-3', 2.8, 'AI'),
        inArea('ai-4', 2.7, 'AI'),
        inArea('plat-1', 1.6, 'Platform'),
        inArea('sec-1', 1.5, 'Security'),
      ],
      { topN: 5 },
    );

    expect(ids(out.selected)).toEqual(['ai-1', 'ai-2', 'ai-3', 'plat-1', 'sec-1']);
    expect(out.dropped).toEqual([{ itemId: 'ai-4', reason: 'below-top-n' }]);
  });

  it('prefers the less-filled capped area once every area has 2 slots', () => {
    const out = run(
      [
        inArea('a-1', 3, 'A'),
        inArea('a-2', 2.9, 'A'),
        inArea('a-3', 2.8, 'A'),
        inArea('a-4', 2.7, 'A'),
        inArea('b-1', 2.6, 'B'),
        inArea('b-2', 2.5, 'B'),
        inArea('b-3', 2.4, 'B'),
      ],
      { topN: 6 },
    );

    expect(ids(out.selected)).toEqual(['a-1', 'a-2', 'a-3', 'b-1', 'b-2', 'b-3']);
  });

  it('counts slots only among items that survived filtering', () => {
    const out = run(
      [
        inArea('a-1', 3, 'A'),
        inArea('a-2', 2.9, 'A'),
        inArea('a-3', 2.8, 'A'),
        inArea('b-low', 0.5, 'B'),
      ],
      { topN: 3 },
    );

    expect(ids(out.selected)).toEqual(['a-1', 'a-2', 'a-3']);
    expect(out.dropped).toEqual([{ itemId: 'b-low', reason: 'low-relevance' }]);
  });

  it('groups areas ignoring case, whitespace and punctuation', () => {
    const out = run(
      [
        inArea('ai-1', 3, 'AI models'),
        inArea('ai-2', 2.9, 'ai models'),
        inArea('ai-3', 2.8, ' AI-Models '),
        inArea('plat-1', 2, 'Platform'),
      ],
      { topN: 3 },
    );

    expect(ids(out.selected)).toEqual(['ai-1', 'ai-2', 'plat-1']);
  });
});

describe('processStep determinism', () => {
  const sample = (): ScoredItem[] => [
    scored('e', { relevance: 2.5, area: 'A' }, { sourceId: 's1', title: 'Story one' }),
    scored('b', { relevance: 2.5, area: 'A' }, { sourceId: 's2', title: 'Story two' }),
    scored('a', { relevance: 2.5, area: 'B' }, { sourceId: 's3', title: 'Story three' }),
    scored('d', { relevance: 3, area: 'A' }, { sourceId: 's4', title: 'Story four' }),
    scored('c', { relevance: 1, area: 'C' }, { sourceId: 's5', title: 'Story five' }),
    scored('f', { relevance: 2, area: 'A' }, { sourceId: 's6', title: 'story ONE' }),
    scored('g', { relevance: 0.5, area: 'D' }, { sourceId: 's7', title: 'Story seven' }),
    scored('h', { relevance: 0.2, area: 'D' }, { sourceId: 's8', title: 'Story eight' }),
    scored('i', { relevance: 3, hype: 0.9, area: 'A' }, { sourceId: 's9', title: 'Story nine' }),
  ];

  it('returns the same output for the same input', () => {
    const items = sample();

    expect(run(structuredClone(items), { topN: 3 })).toEqual(run(items, { topN: 3 }));
  });

  it('returns the same selected and dropped lists whatever the input order', () => {
    const items = sample();
    const expected = run(items, { topN: 3 });

    expect(expected.selected).not.toEqual([]);
    expect(expected.dropped.map((d) => d.reason)).toEqual(
      expect.arrayContaining(['duplicate', 'low-relevance', 'hype', 'below-top-n']),
    );
    expect(run([...items].reverse(), { topN: 3 })).toEqual(expected);
    expect(run([...items.slice(3), ...items.slice(0, 3)], { topN: 3 })).toEqual(expected);
  });

  it('does not mutate its input', () => {
    const items = sample();
    const sentUrls = new Set(['https://example.com/x']);
    const before = structuredClone({ items, sentUrls: [...sentUrls] });

    run(items, { sentUrls, topN: 2 });

    expect({ items, sentUrls: [...sentUrls] }).toEqual(before);
  });
});
