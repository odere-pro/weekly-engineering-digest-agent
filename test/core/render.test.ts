import { describe, expect, it } from 'vitest';
import { buildDigestView } from '../../src/core/layout.js';
import { readSavedDigest, readSavedView, renderDigest, renderView } from '../../src/core/render.js';
import type { Digest, DigestItem } from '../../src/core/schemas.js';
import type { DigestView } from '../../src/ports/Delivery.js';
import { makeDigest, makeDigestItem, makeItem } from '../builders.js';
import { splitCells } from '../fixtures/render/cells.js';

const NONE = { disabledGuards: [] } as const;

function digestOf(...overrides: Partial<DigestItem>[]): Digest {
  const base = makeDigest([]);
  return { ...base, items: overrides.map((patch) => makeDigestItem(makeItem(), patch)) };
}

const lines = (markdown: string): string[] => markdown.split('\n');

describe('renderDigest', () => {
  const digest = digestOf(
    { title: 'Tofu', urgency: 'act-now', action: 'Upgrade.' },
    { title: 'Kube', urgency: 'worth-a-look', action: 'run clusters.' },
    { title: 'Vite', urgency: 'good-to-know' },
  );
  const markdown = renderDigest(digest, NONE);

  it('opens with the computed title, then the headline in italics', () => {
    expect(lines(markdown).slice(0, 3)).toEqual([
      '# Week 2026-W42: 3 releases, 1 needs action',
      '',
      `_${digest.headline}_`,
    ]);
  });

  it('does not render the intro or the old section wording', () => {
    expect(markdown).not.toContain(digest.intro);
    expect(markdown).not.toContain('Why it matters');
    expect(markdown).not.toContain('[Source]');
  });

  it('heads each group with its emoji and label, then a table with its own columns', () => {
    expect(markdown).toContain(
      '## 🔴 Act now\n\n| Release | What changed | What to do |\n|---|---|---|\n',
    );
    expect(markdown).toContain(
      '## 🟡 Worth a look\n\n| Release | What changed | Relevant if you |\n|---|---|---|\n',
    );
    expect(markdown).toContain('## ⚪ Good to know\n\n| Release | What changed |\n|---|---|\n');
  });

  it('links the release title to the item url', () => {
    const first = digest.items[0]!;

    expect(markdown).toContain(`| [Tofu](${first.url}) | ${first.summary} | Upgrade. |`);
  });

  it('ends with one newline and no footer when every guard was on', () => {
    expect(markdown.endsWith('|\n')).toBe(true);
    expect(markdown).not.toContain('---\n\nGuards off');
  });

  it('adds a footer naming the disabled guards', () => {
    const md = renderDigest(digest, { disabledGuards: ['clefPolicy', 'graniteRisk'] });

    expect(md.endsWith('\n\n---\n\nGuards off this week: clefPolicy, graniteRisk.\n')).toBe(true);
  });

  it('leaves out the headline line when the headline is blank', () => {
    const md = renderDigest({ ...digest, headline: ' \n ' }, NONE);

    expect(lines(md).slice(0, 3)).toEqual([
      '# Week 2026-W42: 3 releases, 1 needs action',
      '',
      '## 🔴 Act now',
    ]);
  });

  it('reads an old draft without urgency or action as worth-a-look with why-it-matters', () => {
    const old = digestOf({ title: 'Old', whyItMatters: 'Because.' });

    const md = renderDigest(old, NONE);

    expect(md).toContain('## 🟡 Worth a look');
    expect(md).toContain(`| [Old](${old.items[0]!.url}) | ${old.items[0]!.summary} | Because. |`);
    expect(md).not.toContain('Act now');
  });
});

describe('a column heading repeated in the action', () => {
  const actionCell = (urgency: 'act-now' | 'worth-a-look', action: string): string => {
    const md = renderDigest(digestOf({ urgency, action }), NONE);
    return splitCells(lines(md).find((l) => l.startsWith('| ['))!)[2]!.trim();
  };

  it.each([
    ['Relevant if you run your own clusters.', 'run your own clusters.'],
    ['relevant if you: run clusters', 'run clusters'],
    ['  Relevant if you,  pin versions', 'pin versions'],
    ['RELEVANT IF YOU - ship models', 'ship models'],
  ])('is dropped from a worth-a-look cell: %s', (action, shown) => {
    expect(actionCell('worth-a-look', action)).toBe(shown);
  });

  it.each([
    ["Relevant if you're on Kubernetes.", "Relevant if you're on Kubernetes."],
    ['Relevant if youths join', 'Relevant if youths join'],
    ['It is relevant if you run clusters.', 'It is relevant if you run clusters.'],
    ['Relevant if you', 'Relevant if you'],
    ['Relevant if you.', 'Relevant if you.'],
    ['Relevant if you ...', 'Relevant if you ...'],
  ])('is kept when it is not a repeat: %s', (action, shown) => {
    expect(actionCell('worth-a-look', action)).toBe(shown);
  });

  it('is dropped from an act-now cell the same way', () => {
    expect(actionCell('act-now', 'What to do: upgrade now.')).toBe('upgrade now.');
  });

  it('stays in the view, which has no column heading', () => {
    const view = buildDigestView(
      digestOf({ urgency: 'worth-a-look', action: 'Relevant if you run clusters.' }),
      NONE,
    );

    expect(view.groups[0]?.items[0]?.action).toBe('Relevant if you run clusters.');
  });
});

describe('renderView', () => {
  it('renders the view it is given, the same as renderDigest renders its own', () => {
    const digest = digestOf({ urgency: 'act-now', action: 'Go.' }, { urgency: 'good-to-know' });

    expect(renderView(buildDigestView(digest, NONE))).toBe(renderDigest(digest, NONE));
  });

  it('leaves the action cell empty for a hand-built item without one', () => {
    const view: DigestView = {
      weekId: '2026-W42',
      title: 'Week 2026-W42: 1 release, 1 needs action',
      headline: 'H',
      groups: [
        {
          urgency: 'act-now',
          label: 'Act now',
          items: [{ title: 'A', url: 'https://example.com/a', whatChanged: 'Changed.' }],
        },
      ],
    };

    expect(renderView(view)).toContain('| [A](https://example.com/a) | Changed. |  |\n');
  });
});

describe('readSavedDigest', () => {
  const digest = digestOf(
    { title: 'A [x]', url: 'https://example.com/a', urgency: 'act-now', action: 'Go.' },
    { title: 'B', url: 'https://example.com/b?x=1|2', urgency: 'good-to-know' },
  );

  it('reads the headline and the item urls of the current layout', () => {
    const markdown = renderDigest({ ...digest, headline: 'Runners moved' }, NONE);

    expect(readSavedDigest(markdown)).toEqual({
      headline: 'Runners moved',
      urls: ['https://example.com/a', 'https://example.com/b?x=1|2'],
    });
  });

  it('reads no headline when the layout has none', () => {
    const markdown = renderDigest({ ...digest, headline: '  ' }, NONE);

    expect(readSavedDigest(markdown).headline).toBe('');
  });

  it('reads the footer-bearing layout the same way', () => {
    const markdown = renderDigest(digest, { disabledGuards: ['clefRubric'] });

    expect(readSavedDigest(markdown).urls).toHaveLength(2);
  });

  it('ignores a link that sits in another cell than the release', () => {
    const markdown = renderDigest(
      {
        ...digest,
        items: [{ ...digest.items[0]!, summary: 'See [here](https://example.com/z).' }],
      },
      NONE,
    );

    expect(readSavedDigest(markdown).urls).toEqual(['https://example.com/a']);
  });

  it('reads the digest.md a run saved before W8-02', () => {
    const legacy = [
      '# Runners and gateways moved',
      '',
      '_Week 2026-W42_',
      '',
      'Intro.',
      '',
      '## 1. Runner',
      '',
      'Summary.',
      '',
      '**Why it matters:** Because.',
      '',
      '[Source](https://example.com/runner-1)',
      '',
      '## 2. Gateway',
      '',
      '[Source](https://example.com/runner-2)',
      '',
    ].join('\n');

    expect(readSavedDigest(legacy)).toEqual({
      headline: 'Runners and gateways moved',
      urls: ['https://example.com/runner-1', 'https://example.com/runner-2'],
    });
  });

  it('reads a url with balanced parentheses, a backslash and a pipe back as it was written', () => {
    const urls = [
      'https://example.com/wiki/Foo_(bar)',
      'https://example.com/q?x=a\\b',
      'https://example.com/q?x=a|b',
      'https://example.com/q?x=a\\|b',
    ];
    const items = urls.map((url) => makeDigestItem(makeItem(), { url, urgency: 'good-to-know' }));

    expect(readSavedDigest(renderDigest({ ...digest, items }, NONE)).urls).toEqual(urls);
  });

  it('reads a title with brackets, backslashes and pipes without losing the url', () => {
    const title = 'a [b] c\\ d | e \\| f';
    const item = makeDigestItem(makeItem(), { title, urgency: 'act-now', action: 'Go.' });

    expect(readSavedDigest(renderDigest({ ...digest, items: [item] }, NONE)).urls).toEqual([
      item.url,
    ]);
  });

  it('does not take a line that looks like a title for the layout of a digest saved before', () => {
    const legacy =
      '# Old headline\n\n_Week 2026-W42_\n\n# Week 2026-W01: x\n\n[Source](https://example.com/a)\n';

    expect(readSavedDigest(legacy)).toEqual({
      headline: 'Old headline',
      urls: ['https://example.com/a'],
    });
  });

  it('reads a long file of unfinished release rows without slowing down', () => {
    const rows = Array.from({ length: 20_000 }, () => '| [unfinished \\ | x').join('\n');
    const started = performance.now();

    const saved = readSavedDigest(
      `# Week 2026-W42: 1 release, 1 needs action\n\n## 🔴 Act now\n\n| Release |\n|---|\n${rows}\n`,
    );

    expect(saved.urls).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('counts the release rows of a table under a heading it does not know', () => {
    const markdown = renderDigest(digest, NONE).replace('🔴', '🟣');

    expect(readSavedDigest(markdown).urls).toEqual([
      'https://example.com/a',
      'https://example.com/b?x=1|2',
    ]);
  });

  it('reads a headline that starts like a title as the legacy layout', () => {
    const legacy = `# Week 2026-W42: runners moved\n\n_Week 2026-W42_\n\n[Source](https://example.com/a)\n`;

    expect(readSavedDigest(legacy)).toEqual({
      headline: 'Week 2026-W42: runners moved',
      urls: ['https://example.com/a'],
    });
  });

  it('renders and reads a very long run of backslashes without slowing down', () => {
    const slashes = '\\'.repeat(60_000);
    const item = { ...digest.items[0]!, summary: slashes, action: `${slashes}|` };
    const started = performance.now();

    const markdown = renderDigest({ ...digest, items: [item] }, NONE);
    const saved = readSavedView(markdown);

    expect(saved?.groups[0]?.items[0]?.whatChanged).toBe(slashes);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('reads nothing from text that is not a digest', () => {
    expect(readSavedDigest('hello\n')).toEqual({ headline: '', urls: [] });
  });
});
