import { describe, expect, it } from 'vitest';
import { digestItemIds, parseDigestMarkdown } from './parseDigest';
import { renderDigest } from '../../../src/render/markdown';
import type { DigestItem, Item } from '../../../src/domain/schemas';
import { makeDigest, makeDigestItem, makeItem } from '../../../test/builders';

function makeItems(count: number): Item[] {
  return Array.from({ length: count }, () => makeItem());
}

describe('parseDigestMarkdown', () => {
  const urgent = (item: Item, urgency: DigestItem['urgency'], action?: string) =>
    makeDigestItem(item, { urgency, ...(action === undefined ? {} : { action }) });

  it('reads back what renderDigest wrote: headline, items, summaries and actions', () => {
    const items = makeItems(3);
    const digest = makeDigest(items);
    const markdown = renderDigest(digest, { disabledGuards: ['clefRubric'] });

    const parsed = parseDigestMarkdown(markdown, digest.weekId, items);

    expect(parsed.weekId).toBe(digest.weekId);
    expect(parsed.headline).toBe(digest.headline);
    expect(parsed.items.map((i) => i.itemId)).toEqual(items.map((i) => i.id));
    expect(parsed.items.map((i) => i.title)).toEqual(digest.items.map((i) => i.title));
    expect(parsed.items.map((i) => i.summary)).toEqual(digest.items.map((i) => i.summary));
    expect(parsed.items.map((i) => i.url)).toEqual(digest.items.map((i) => i.url));
    // An old draft's why-it-matters is printed as its action, under worth-a-look.
    expect(parsed.items.map((i) => i.action)).toEqual(digest.items.map((i) => i.whyItMatters));
    expect(parsed.items.map((i) => i.urgency)).toEqual(items.map(() => 'worth-a-look'));
  });

  it('has an empty intro and an empty why-it-matters, because the layout prints neither', () => {
    const items = makeItems(3);
    const markdown = renderDigest(makeDigest(items), { disabledGuards: [] });

    const parsed = parseDigestMarkdown(markdown, '2026-W42', items);

    expect(parsed.intro).toBe('');
    expect(parsed.items.map((i) => i.whyItMatters)).toEqual(['', '', '']);
  });

  it('reads the urgency from the group an item is printed under, and the order as printed', () => {
    const [a, b, c] = makeItems(3) as [Item, Item, Item];
    const digest = {
      ...makeDigest([]),
      items: [urgent(a, 'good-to-know'), urgent(b, 'act-now', 'Upgrade.'), urgent(c, undefined)],
    };

    const parsed = parseDigestMarkdown(renderDigest(digest, { disabledGuards: [] }), '', [a, b, c]);

    expect(parsed.items.map((i) => [i.itemId, i.urgency])).toEqual([
      [b.id, 'act-now'],
      [c.id, 'worth-a-look'],
      [a.id, 'good-to-know'],
    ]);
    expect(parsed.items[0]?.action).toBe('Upgrade.');
  });

  it('gives a good-to-know item no action', () => {
    const [a] = makeItems(1) as [Item];
    const digest = { ...makeDigest([]), items: [urgent(a, 'good-to-know', 'Dropped.')] };

    const parsed = parseDigestMarkdown(renderDigest(digest, { disabledGuards: [] }), '', [a]);

    expect(parsed.items[0]).not.toHaveProperty('action');
  });

  it('does not mistake the guards footer for part of the last item', () => {
    const items = makeItems(3);
    const markdown = renderDigest(makeDigest(items), { disabledGuards: ['clefRubric'] });

    const parsed = parseDigestMarkdown(markdown, '2026-W42', items);

    expect(parsed.items).toHaveLength(3);
    expect(parsed.items.at(-1)?.url).toBe(items[2]?.url);
    expect(parsed.items.at(-1)?.action).toBe('It changes how teams build and run software.');
  });

  it('reads text that a table cell had to escape as it was written', () => {
    const [a] = makeItems(1) as [Item];
    const digest = {
      ...makeDigest([]),
      items: [
        makeDigestItem(a, {
          title: 'Parser [beta] | 1.0',
          summary: 'Adds the a|b operator.',
          urgency: 'act-now',
          action: 'Replace the pipe | in your configs.',
        }),
      ],
    };

    const parsed = parseDigestMarkdown(renderDigest(digest, { disabledGuards: [] }), '', [a]);

    expect(parsed.items[0]).toMatchObject({
      itemId: a.id,
      title: 'Parser [beta] | 1.0',
      summary: 'Adds the a|b operator.',
      action: 'Replace the pipe | in your configs.',
    });
  });

  it('marks a link to an uncollected URL as unmatched', () => {
    const items = makeItems(1);
    const markdown = [
      '# Week 2026-W42: 1 release, nothing needs action',
      '',
      '_H_',
      '',
      '## 🟡 Worth a look',
      '',
      '| Release | What changed | Relevant if you |',
      '|---|---|---|',
      '| [T](https://evil.example/x) | S. | W. |',
      '',
    ].join('\n');

    const parsed = parseDigestMarkdown(markdown, '2026-W42', items);

    expect(parsed.items[0]?.itemId).toBe('unmatched:https://evil.example/x');
  });

  it('yields empty sections for text that is not a digest', () => {
    const parsed = parseDigestMarkdown('just some words', '2026-W42', []);

    expect(parsed).toEqual({ weekId: '2026-W42', headline: '', intro: '', items: [] });
  });

  it('leaves the link empty when an item row has no link', () => {
    const markdown = [
      '# Week 2026-W42: 1 release, nothing needs action',
      '',
      '## ⚪ Good to know',
      '',
      '| Release | What changed |',
      '|---|---|',
      '| T | S. |',
      '',
    ].join('\n');

    const parsed = parseDigestMarkdown(markdown, '2026-W42', []);

    expect(parsed.headline).toBe('');
    expect(parsed.items[0]).toMatchObject({ title: 'T', summary: 'S.', url: '' });
  });
});

describe('digestItemIds', () => {
  it('maps digest links to collected item ids, ignoring URL tracking noise', () => {
    const [a, b] = makeItems(2) as [Item, Item];
    const markdown = renderDigest(makeDigest([{ ...a, url: `${a.url}?utm_source=x` }, b]), {
      disabledGuards: [],
    });
    expect(digestItemIds(markdown, [a, b])).toEqual([a.id, b.id]);
  });
});
