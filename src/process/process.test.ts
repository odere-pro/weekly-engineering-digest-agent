// The step end to end: how filter, dedupe and rank work together. Each part has its own test in
// its folder (filter/, dedupe/, rank/); this file pins the contract that joins them.
import { describe, expect, it } from 'vitest';
import { processStep, type ProcessInput } from './process';
import { defaultThresholds as thresholds, ids, scored, story } from './__fixtures__/processKit';
import type { ScoredItem } from '../classify/classification';
import { DigestError } from '../shared/errors';

function run(items: readonly ScoredItem[], overrides: Partial<ProcessInput> = {}) {
  return processStep({
    items,
    sentUrls: new Set<string>(),
    thresholds,
    topN: 5,
    ...overrides,
  });
}

describe('processStep drop reasons', () => {
  it('keeps clean items and reports nothing dropped', () => {
    const out = run([scored('a'), scored('b')]);

    expect(ids(out.selected).sort()).toEqual(['a', 'b']);
    expect(out.dropped).toEqual([]);
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

  it('lists the filter drops first, then below-top-n in rank order', () => {
    const out = run(
      [
        scored('a', { relevance: 3, area: 'a' }),
        scored('b', { relevance: 2.9, area: 'b' }),
        scored('c', { relevance: 2.8, area: 'c' }),
        scored('low', { relevance: 0 }),
        scored('hyped', { hype: 1 }),
      ],
      { topN: 2 },
    );

    expect(ids(out.selected)).toEqual(['a', 'b']);
    expect(out.dropped).toEqual([
      { itemId: 'low', reason: 'low-relevance' },
      { itemId: 'hyped', reason: 'hype' },
      { itemId: 'c', reason: 'below-top-n' },
    ]);
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

  it('drops a sent URL even when a tracked copy of it comes from another feed', () => {
    const tracked = scored('tracked', {}, { url: 'https://Example.com/posts/a/?utm_source=rss#x' });
    const fresh = scored('fresh', {}, { url: 'https://example.com/posts/b' });

    const out = run([tracked, fresh], { sentUrls: new Set(['https://example.com/posts/a']) });

    expect(ids(out.selected)).toEqual(['fresh']);
    expect(out.dropped).toEqual([{ itemId: 'tracked', reason: 'sent-before' }]);
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
    const blog = story('blog', 'blog', 'Kubernetes 1.34 is out!', 2.2);
    const news = story('news', 'news', '  kubernetes   1.34 is OUT ', 2.8);

    const out = run([blog, news]);

    expect(ids(out.selected)).toEqual(['news']);
    expect(out.dropped).toEqual([{ itemId: 'blog', reason: 'duplicate' }]);
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
    const a = story('a', 's1', 'Big launch', 2);
    const b = story('b', 's2', 'Big launch', 3);
    const c = story('c', 's3', 'big launch', 2.5);

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
  it('keeps one entry when two sources announce the same product and version (Muse Spark Open)', () => {
    const hub = story('hub', 'huggingface-blog', 'Muse Spark Open 1.0 is now on Hugging Face', 2.4);
    const aws = story(
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
    const low = story('low', 'blog-a', 'Muse Spark Open 1.0 arrives', 2.1);
    const high = story('high', 'blog-b', 'Muse Spark Open 1.0 now available', 2.8);

    expect(ids(run([low, high]).selected)).toEqual(['high']);
    expect(ids(run([high, low]).selected)).toEqual(['high']);
  });

  it('collapses three sources to the best one', () => {
    const out = run([
      story('a', 's1', 'Kubernetes 1.34 is out', 2.2),
      story('b', 's2', 'Kubernetes v1.34: Of Wind & Will', 2.9),
      story('c', 's3', 'Introducing Kubernetes 1.34', 2.5),
    ]);

    expect(ids(out.selected)).toEqual(['b']);
    expect(out.dropped).toEqual([
      { itemId: 'c', reason: 'duplicate' },
      { itemId: 'a', reason: 'duplicate' },
    ]);
  });

  it('matches a GitHub release title against a blog post for the same tag', () => {
    const github = story(
      'gh',
      'transformers-releases',
      'transformers v5.20.0: Release v5.20.0',
      2.3,
    );
    const blog = story('blog', 'huggingface-blog', 'Transformers 5.20.0 is out', 2.7);

    const out = run([github, blog]);

    expect(ids(out.selected)).toEqual(['blog']);
    expect(out.dropped).toEqual([{ itemId: 'gh', reason: 'duplicate' }]);
  });

  it('runs after sent-before, so a sent copy does not hide a fresh one', () => {
    const sent = scored(
      'sent',
      { relevance: 3 },
      { sourceId: 's1', title: 'Tool 4.0 is out', url: 'https://example.com/sent' },
    );
    const fresh = story('fresh', 's2', 'Tool v4.0 released', 2);

    const out = run([sent, fresh], { sentUrls: new Set(['https://example.com/sent']) });

    expect(ids(out.selected)).toEqual(['fresh']);
    expect(out.dropped).toEqual([{ itemId: 'sent', reason: 'sent-before' }]);
  });

  it('does not modify its input', () => {
    const items = Object.freeze([
      Object.freeze(story('a', 's1', 'Tool 5.0 is out')),
      Object.freeze(story('b', 's2', 'Tool 5.0 ships')),
    ]);
    const snapshot = structuredClone(items);

    run(items);

    expect(items).toEqual(snapshot);
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

  it('names the step in the error for a bad topN', () => {
    expect(() => run(many(), { topN: -1 })).toThrow(/topN must be a non-negative integer, got -1/);
  });

  it('returns exactly topN items when more survive, tied items in publishedAt then id order (W7-03)', () => {
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
  it('spreads over areas and lists the selection in rank order', () => {
    const inArea = (id: string, relevance: number, area: string) => scored(id, { relevance, area });

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

  it('counts slots only among items that survived filtering', () => {
    const inArea = (id: string, relevance: number, area: string) => scored(id, { relevance, area });

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

describe('processStep pairwise order (W11-07)', () => {
  it('ranks listed items by their position before relevance', () => {
    const low = scored('low', { relevance: 2 });
    const high = scored('high', { relevance: 3 });
    const input = { items: [high, low], sentUrls: new Set<string>(), thresholds, topN: 1 };

    expect(ids(processStep(input).selected)).toEqual(['high']);
    expect(ids(processStep({ ...input, pairwiseOrder: ['low', 'high'] }).selected)).toEqual([
      'low',
    ]);
  });

  it('ranks items outside the order after the listed ones', () => {
    const listed = scored('listed', { relevance: 2 });
    const other = scored('other', { relevance: 3 });

    const out = run([other, listed], { topN: 2, pairwiseOrder: ['listed'] });

    expect(ids(out.selected)).toEqual(['listed', 'other']);
  });
});
