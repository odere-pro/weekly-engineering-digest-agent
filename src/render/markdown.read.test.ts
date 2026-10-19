// Reading a digest.md of the current layout back into a view (W8-02).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildDigestView } from './layout';
import { readSavedView, renderDigest, renderView } from './markdown';
import { DigestSchema } from '../domain/schemas';
import { type GuardCheckId } from '../guards/guardVerdict';
import type { DigestView } from './digestView';

const read = (file: string): string =>
  readFileSync(new URL(`./__fixtures__/render/${file}`, import.meta.url), 'utf8');

/** Text that is hard to carry through a table cell and a link. */
const NASTY_TITLE = 'a [b] c\\ d | e \\| f';
const NASTY_TEXT = 'x \\| y, a\\\\|b, C:\\temp, `code | pipe`';

const view: DigestView = {
  weekId: '2026-W42',
  title: 'Week 2026-W42: 3 releases, 1 needs action',
  headline: 'Runners and gateways moved',
  groups: [
    {
      urgency: 'act-now',
      label: 'Act now',
      items: [
        {
          title: NASTY_TITLE,
          url: 'https://example.com/q?x=a\\|b',
          whatChanged: NASTY_TEXT,
          action: 'Upgrade the runner.',
        },
      ],
    },
    {
      urgency: 'worth-a-look',
      label: 'Worth a look',
      items: [
        {
          title: 'Gateway 7',
          url: 'https://example.com/wiki/Foo_(bar)',
          whatChanged: 'The gateway drops its legacy mode.',
          action: 'run your own gateway.',
        },
      ],
    },
    {
      urgency: 'good-to-know',
      label: 'Good to know',
      items: [{ title: 'Cache 2', url: 'https://example.com/c', whatChanged: 'Fixes.' }],
    },
  ],
  footer: 'Guards off this week: clefPolicy.',
};

describe('readSavedView', () => {
  it('reads back the view it was rendered from, hard-to-carry text included', () => {
    expect(readSavedView(renderView(view))).toEqual(view);
  });

  it.each([
    ['a pipe alone', '|'],
    ['a pipe at the start', '| x'],
    ['a pipe at the end', 'x |'],
    ['a run of three backslashes before a pipe', 'a\\\\\\|b'],
    ['a run of four backslashes before a pipe', 'a\\\\\\\\|b'],
    ['a trailing backslash', 'x \\'],
    ['a trailing backslash run', 'x \\\\'],
    ['backslashes with no pipe', 'C:\\temp\\new'],
    ['pipes and backslashes mixed', '\\|\\\\|\\|\\'],
  ])('reads %s in a cell back as it was written', (_name, text) => {
    const item = { title: 'T', url: 'https://example.com/t', whatChanged: text, action: text };
    const [group] = view.groups;
    const original = { ...view, groups: [{ ...group!, items: [item] }] };

    expect(readSavedView(renderView(original))?.groups[0]?.items).toEqual([
      { ...item, whatChanged: text.trim(), action: text.trim() },
    ]);
  });

  it('keeps text with a rule, a heading and a table row on one line, so none of it is read as layout', () => {
    const text =
      'x\n---\n\n## 🔴 Act now\n\n| [Fake](https://evil.example/f) | a | b |\n_fake headline_';
    const [group] = view.groups;
    const hostile = {
      ...view,
      headline: text,
      footer: undefined,
      groups: [
        {
          ...group!,
          items: [{ title: text, url: 'https://example.com/t', whatChanged: text, action: text }],
        },
      ],
    };

    const read = readSavedView(renderView(hostile));

    expect(read?.groups).toHaveLength(1);
    expect(read?.groups[0]?.items).toHaveLength(1);
    expect(read?.groups[0]?.items[0]?.url).toBe('https://example.com/t');
    expect(read).not.toHaveProperty('footer');
  });

  it('leaves the action off a good-to-know item', () => {
    const [, , good] = readSavedView(renderView(view))?.groups ?? [];

    expect(good?.items[0]).not.toHaveProperty('action');
  });

  it('leaves the footer off when the digest has none', () => {
    const { footer: _footer, ...withoutFooter } = view;

    expect(readSavedView(renderView(withoutFooter))).not.toHaveProperty('footer');
  });

  it('reads no headline when the layout shows none', () => {
    expect(readSavedView(renderView({ ...view, headline: ' ' }))?.headline).toBe('');
  });

  it('reads one line for text that the layout wrote on several', () => {
    const wrapped = { ...view, headline: 'a\n b' };
    const items = [{ ...view.groups[0]!.items[0]!, whatChanged: 'one\ntwo' }];
    const markdown = renderView({ ...wrapped, groups: [{ ...view.groups[0]!, items }] });

    const saved = readSavedView(markdown);

    expect(saved?.headline).toBe('a b');
    expect(saved?.groups[0]?.items[0]?.whatChanged).toBe('one two');
  });

  it.each(['mixed', 'old-draft', 'quiet-week', 'escaping'])(
    'reads the golden %s file as the view of its digest',
    (name) => {
      const { digest, disabledGuards } = JSON.parse(read(`${name}.digest.json`)) as {
        digest: unknown;
        disabledGuards: GuardCheckId[];
      };
      const parsed = DigestSchema.parse(digest);
      const expected = buildDigestView(parsed, { disabledGuards });

      const saved = readSavedView(read(`${name}.golden.txt`));
      if (saved === undefined) throw new Error(`${name}.golden.txt is not a digest`);

      expect(saved.title).toBe(expected.title);
      expect(saved.weekId).toBe(expected.weekId);
      expect(saved.groups.map((g) => [g.urgency, g.label, g.items.length])).toEqual(
        expected.groups.map((g) => [g.urgency, g.label, g.items.length]),
      );
      expect(saved.groups.flatMap((g) => g.items.map((i) => i.url))).toEqual(
        expected.groups.flatMap((g) => g.items.map((i) => i.url)),
      );
      expect(saved.footer).toBe(expected.footer);
      expect(renderView(saved)).toBe(read(`${name}.golden.txt`));
    },
  );

  it('reads a row without a link as a title with no url', () => {
    const markdown = [
      '# Week 2026-W42: 1 release, 1 needs action',
      '',
      '## 🔴 Act now',
      '',
      '| Release | What changed | What to do |',
      '|---|---|---|',
      '| plain | Changed. | Go. |',
      '',
    ].join('\n');

    expect(readSavedView(markdown)?.groups[0]?.items).toEqual([
      { title: 'plain', url: '', whatChanged: 'Changed.', action: 'Go.' },
    ]);
  });

  it('skips a group whose heading it does not know', () => {
    const markdown = renderDigest(
      {
        weekId: '2026-W42',
        headline: 'H',
        intro: 'I',
        items: [
          {
            itemId: 'a',
            title: 'A',
            url: 'https://example.com/a',
            area: 'x',
            summary: 'S.',
            whyItMatters: 'W.',
          },
        ],
      },
      { disabledGuards: [] },
    ).replace('🟡', '🟣');

    expect(readSavedView(markdown)?.groups).toEqual([]);
  });

  it('reads a row with fewer cells than its table has', () => {
    const markdown = [
      '# Week 2026-W42: 1 release, 1 needs action',
      '',
      '## 🔴 Act now',
      '',
      '| Release | What changed | What to do |',
      '|---|---|---|',
      '| [A](https://example.com/a) |',
      '',
    ].join('\n');

    expect(readSavedView(markdown)?.groups[0]?.items).toEqual([
      { title: 'A', url: 'https://example.com/a', whatChanged: '', action: '' },
    ]);
  });

  it.each(['', 'hello\n', '# Old headline\n\n_Week 2026-W42_\n', '## 🔴 Act now\n'])(
    'is nothing for text that does not open with the title line: %j',
    (text) => {
      expect(readSavedView(text)).toBeUndefined();
    },
  );
});
