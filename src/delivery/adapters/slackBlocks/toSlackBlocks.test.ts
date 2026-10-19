import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toSlackBlocks, type SlackBlock, type SlackMessage } from './toSlackBlocks';
import type { DigestView, DigestViewGroup, DigestViewItem } from '../../../render/digestView';

const SECTION_LIMIT = 3000;
const BLOCK_LIMIT = 50;
const HEADER_LIMIT = 150;

const fixtures = join(import.meta.dirname, '__fixtures__');

function loadView(): DigestView {
  return JSON.parse(readFileSync(join(fixtures, 'digest-view.json'), 'utf8')) as DigestView;
}

function loadGolden(): SlackMessage {
  return JSON.parse(readFileSync(join(fixtures, 'digest-blocks.json'), 'utf8')) as SlackMessage;
}

function item(overrides: Partial<DigestViewItem> = {}): DigestViewItem {
  return {
    title: 'Ollama 0.9',
    url: 'https://example.com/ollama',
    whatChanged: 'The default context window grows.',
    ...overrides,
  };
}

function group(
  urgency: DigestViewGroup['urgency'],
  items: readonly DigestViewItem[],
  label = 'Act now',
): DigestViewGroup {
  return { urgency, label, items };
}

function view(overrides: Partial<DigestView> = {}): DigestView {
  return {
    weekId: '2026-W42',
    title: 'Week 2026-W42: 1 release, 1 needs action',
    headline: 'One release matters this week.',
    groups: [group('act-now', [item()])],
    ...overrides,
  };
}

/** Items with every field at its longest, so no two of them share a section. */
function bigItems(count: number, prefix = 'Release'): DigestViewItem[] {
  return Array.from({ length: count }, (_, index) =>
    item({
      title: `${prefix} ${String(index)} ${'t'.repeat(190)}`,
      whatChanged: 'x'.repeat(1000),
      action: 'y'.repeat(400),
    }),
  );
}

function sections(message: SlackMessage): string[] {
  return message.blocks.flatMap((block) => (block.type === 'section' ? [block.text.text] : []));
}

type BlockOf<T extends SlackBlock['type']> = Extract<SlackBlock, { type: T }>;

function blockAt<T extends SlackBlock['type']>(
  message: SlackMessage,
  index: number,
  type: T,
): BlockOf<T> {
  const block = message.blocks.at(index);
  if (block?.type !== type) throw new Error(`Expected a ${type} block at ${String(index)}`);
  return block as BlockOf<T>;
}

function allText(message: SlackMessage): string {
  return JSON.stringify(message);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

describe('toSlackBlocks', () => {
  describe('layout', () => {
    it('renders the approved example exactly (golden)', () => {
      const message = toSlackBlocks(loadView());

      expect(message).toEqual(loadGolden());
    });

    it('opens with a header (the title) and a context block (the headline)', () => {
      const { blocks } = toSlackBlocks(view());

      expect(blocks[0]).toEqual({
        type: 'header',
        text: { type: 'plain_text', text: 'Week 2026-W42: 1 release, 1 needs action' },
      });
      expect(blocks[1]).toEqual({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: 'One release matters this week.' }],
      });
    });

    it.each([
      ['act-now', 'Act now', '🔴'],
      ['worth-a-look', 'Worth a look', '🟡'],
      ['good-to-know', 'Good to know', '⚪'],
    ] as const)('marks the %s group with %s', (urgency, label, emoji) => {
      const message = toSlackBlocks(view({ groups: [group(urgency, [item()], label)] }));

      expect(sections(message)[0]?.startsWith(`*${emoji} ${label}*\n`)).toBe(true);
    });

    it('puts one bullet per item with the link as a bold title and the action on the next line', () => {
      const message = toSlackBlocks(
        view({
          groups: [
            group('act-now', [
              item({
                title: 'A',
                url: 'https://example.com/a',
                whatChanged: 'a changed.',
                action: 'do a',
              }),
              item({ title: 'B', url: 'https://example.com/b', whatChanged: 'b changed.' }),
            ]),
          ],
        }),
      );

      expect(sections(message)).toEqual([
        '*🔴 Act now*\n• *<https://example.com/a|A>*: a changed.\n→ do a\n• *<https://example.com/b|B>*: b changed.',
      ]);
    });

    it('keeps the groups and the items in the order given', () => {
      const message = toSlackBlocks(
        view({
          groups: [
            group(
              'good-to-know',
              [item({ title: 'second' }), item({ title: 'first' })],
              'Good to know',
            ),
            group('act-now', [item({ title: 'third' })]),
          ],
        }),
      );

      const text = sections(message).join('\n');
      expect(text.indexOf('second')).toBeLessThan(text.indexOf('first'));
      expect(text.indexOf('first')).toBeLessThan(text.indexOf('third'));
    });

    it('puts a divider between groups and not after the last one', () => {
      const { blocks } = toSlackBlocks(
        view({
          groups: [
            group('act-now', [item()]),
            group('worth-a-look', [item()], 'Worth a look'),
            group('good-to-know', [item()], 'Good to know'),
          ],
        }),
      );

      expect(blocks.map((block) => block.type)).toEqual([
        'header',
        'context',
        'section',
        'divider',
        'section',
        'divider',
        'section',
      ]);
    });

    it('adds the footer as a closing context block', () => {
      const { blocks } = toSlackBlocks(view({ footer: 'Guards off: granite.' }));

      expect(blocks.at(-1)).toEqual({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: 'Guards off: granite.' }],
      });
    });

    it('has no closing block when there is no footer', () => {
      const { blocks } = toSlackBlocks(view());

      expect(blocks.at(-1)?.type).toBe('section');
    });

    it('shows only the header and the headline when there are no groups', () => {
      const { blocks } = toSlackBlocks(view({ groups: [] }));

      expect(blocks.map((block) => block.type)).toEqual(['header', 'context']);
    });

    it('skips a group without items, so no empty section or stray divider appears', () => {
      const { blocks } = toSlackBlocks(
        view({
          groups: [group('act-now', []), group('worth-a-look', [item()], 'Worth a look')],
        }),
      );

      expect(blocks.map((block) => block.type)).toEqual(['header', 'context', 'section']);
    });

    it('treats a blank action as no action', () => {
      const message = toSlackBlocks(
        view({ groups: [group('act-now', [item({ action: '  \n ' })])] }),
      );

      expect(sections(message)[0]).not.toContain('→');
    });

    it('leaves out the headline block when the headline is blank, since Slack rejects empty text', () => {
      const message = toSlackBlocks(view({ headline: ' \n ' }));

      expect(message.blocks.map((block) => block.type)).toEqual(['header', 'section']);
      expect(message.text).toBe('Week 2026-W42: 1 release, 1 needs action');
    });

    it('names the week in the header when the title is blank', () => {
      const message = toSlackBlocks(view({ title: '  ' }));

      expect(blockAt(message, 0, 'header').text.text).toBe('Weekly digest 2026-W42');
      expect(message.text).toBe('Weekly digest 2026-W42\nOne release matters this week.');
    });

    it('never emits a header, context or fallback text that is empty', () => {
      const message = toSlackBlocks(view({ title: '', headline: '', footer: ' ', groups: [] }));

      expect(message.text).not.toBe('');
      expect(message.blocks.map((block) => block.type)).toEqual(['header']);
      expect(blockAt(message, 0, 'header').text.text).not.toBe('');
    });
  });

  describe('fallback text', () => {
    it('is the title and the headline, for notifications', () => {
      const { text } = toSlackBlocks(view());

      expect(text).toBe('Week 2026-W42: 1 release, 1 needs action\nOne release matters this week.');
    });

    it('escapes the headline and keeps it on one line', () => {
      const { text } = toSlackBlocks(view({ headline: 'A <!channel>\nB & C' }));

      expect(text).toBe('Week 2026-W42: 1 release, 1 needs action\nA &lt;!channel&gt; B &amp; C');
    });
  });

  describe('escaping', () => {
    it('escapes &, < and > in every piece of model text', () => {
      const message = toSlackBlocks(
        view({
          headline: 'head <b> & more',
          footer: 'foot <i> & more',
          groups: [
            group(
              'act-now',
              [item({ title: 'T <x> & y', whatChanged: 'W <x> & y', action: 'A <x> & y' })],
              'L <x> & y',
            ),
          ],
        }),
      );

      const text = allText(message);
      expect(text).toContain('head &lt;b&gt; &amp; more');
      expect(text).toContain('foot &lt;i&gt; &amp; more');
      expect(text).toContain('L &lt;x&gt; &amp; y');
      expect(text).toContain('T &lt;x&gt; &amp; y');
      expect(text).toContain('W &lt;x&gt; &amp; y');
      expect(text).toContain('A &lt;x&gt; &amp; y');
    });

    it.each([
      '<!channel>',
      '<!here>',
      '<@U123ABC>',
      '<#C123>',
      '<!subteam^S123>',
      '<https://evil.example|click>',
    ])('does not let %s through as a Slack control token', (token) => {
      const message = toSlackBlocks(
        view({
          headline: token,
          footer: token,
          groups: [
            group('act-now', [item({ title: token, whatChanged: token, action: token })], token),
          ],
        }),
      );

      // The only raw angle brackets are the pair that makes the item link.
      const withoutLink = allText(message).replace(
        /<https:\/\/example\.com\/ollama\|([^<>]*)>/,
        '$1',
      );
      expect(withoutLink).not.toMatch(/[<>]/);
    });

    it('keeps an & in the link url escaped the way Slack expects', () => {
      const message = toSlackBlocks(
        view({ groups: [group('act-now', [item({ url: 'https://example.com/a?b=1&c=2' })])] }),
      );

      expect(sections(message)[0]).toContain('<https://example.com/a?b=1&amp;c=2|Ollama 0.9>');
    });

    it('encodes a | in the url so it cannot end the link early', () => {
      const message = toSlackBlocks(
        view({ groups: [group('act-now', [item({ url: 'https://example.com/a|b' })])] }),
      );

      expect(sections(message)[0]).toContain('<https://example.com/a%7Cb|Ollama 0.9>');
    });

    it('cannot be closed early by a > or a space in the url', () => {
      const message = toSlackBlocks(
        view({
          groups: [group('act-now', [item({ url: 'https://example.com/a> <!channel> b' })])],
        }),
      );

      const text = sections(message)[0] ?? '';
      expect(text).not.toContain('<!channel');
      expect(text.match(/</g)).toHaveLength(1);
      expect(text.match(/>/g)).toHaveLength(1);
    });

    it.each([
      'javascript:alert(1)',
      '!channel',
      '@U123ABC',
      '/relative/path',
      'ftp://example.com/file',
      'not a url',
      '',
    ])('shows the title without a link for the url %j', (url) => {
      const message = toSlackBlocks(view({ groups: [group('act-now', [item({ url })])] }));

      expect(sections(message)[0]).toBe(
        '*🔴 Act now*\n• *Ollama 0.9*: The default context window grows.',
      );
    });

    it('shows the title without a link when the url is too long for a section', () => {
      const url = `https://example.com/${'a'.repeat(2500)}`;
      const message = toSlackBlocks(view({ groups: [group('act-now', [item({ url })])] }));

      const text = sections(message)[0] ?? '';
      expect(text).not.toContain('aaaa');
      expect(text).toContain('• *Ollama 0.9*:');
    });

    it('collapses line breaks in model text, so it cannot forge bullets or headings', () => {
      const message = toSlackBlocks(
        view({
          headline: 'line one\n\nline two',
          groups: [
            group('act-now', [
              item({
                title: 'T\n• *fake*',
                whatChanged: 'W\n*🔴 Act now*\n• forged',
                action: 'A\r\n→ forged',
              }),
            ]),
          ],
        }),
      );

      expect(sections(message)[0]?.split('\n')).toHaveLength(3);
      expect(message.blocks[1]).toEqual({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: 'line one line two' }],
      });
    });
  });

  describe('hardening', () => {
    it('shows the title without a link when the url carries a user name or password', () => {
      for (const url of ['https://github.com@evil.example/x', 'https://user:pw@example.com/']) {
        const message = toSlackBlocks(view({ groups: [group('act-now', [item({ url })])] }));

        expect(sections(message)[0]).toBe(
          '*🔴 Act now*\n• *Ollama 0.9*: The default context window grows.',
        );
      }
    });

    it('replaces backticks, so a code fence cannot swallow the bullets after it', () => {
      const message = toSlackBlocks(
        view({
          groups: [
            group('act-now', [
              item({ title: 'a ```code', whatChanged: 'b ```', action: 'c `x`' }),
              item({ title: 'next' }),
            ]),
          ],
        }),
      );

      expect(allText(message)).not.toContain('`');
    });

    it('turns control characters into spaces', () => {
      const message = toSlackBlocks(
        view({
          groups: [group('act-now', [item({ whatChanged: 'a\u0000b\u001bc\u0085d\u2028e' })])],
        }),
      );

      expect(sections(message)[0]).toContain(': a b c d e');
    });

    it('builds a new divider for each message, so one caller cannot change another', () => {
      const twoGroups = view({
        groups: [group('act-now', [item()]), group('worth-a-look', [item()], 'Worth a look')],
      });
      const dividerOf = (message: SlackMessage): SlackBlock | undefined =>
        message.blocks.find((block) => block.type === 'divider');

      expect(dividerOf(toSlackBlocks(twoGroups))).toEqual({ type: 'divider' });
      expect(dividerOf(toSlackBlocks(twoGroups))).not.toBe(dividerOf(toSlackBlocks(twoGroups)));
    });
  });

  describe('Slack limits', () => {
    it('cuts a title longer than 150 characters in the header', () => {
      const message = toSlackBlocks(view({ title: `Week 2026-W42: ${'x '.repeat(200)}` }));

      const header = blockAt(message, 0, 'header');
      expect(header.text.text.length).toBeLessThanOrEqual(HEADER_LIMIT);
      expect(header.text.text.endsWith('...')).toBe(true);
    });

    it('keeps a title of exactly 150 characters whole', () => {
      const title = 'x'.repeat(HEADER_LIMIT);
      const message = toSlackBlocks(view({ title }));

      expect(blockAt(message, 0, 'header').text.text).toBe(title);
    });

    it('splits a long group into several sections of at most 3000 characters', () => {
      const items = Array.from({ length: 12 }, (_, index) =>
        item({
          title: `Release ${String(index)}`,
          url: `https://example.com/${String(index)}`,
          whatChanged: 'x'.repeat(800),
          action: 'y'.repeat(150),
        }),
      );
      const message = toSlackBlocks(view({ groups: [group('act-now', items)] }));

      const texts = sections(message);
      expect(texts.length).toBeGreaterThan(1);
      for (const text of texts) expect(text.length).toBeLessThanOrEqual(SECTION_LIMIT);
      // Every item survives, in order, once.
      for (let index = 0; index < items.length; index += 1) {
        expect(texts.join('\n').split(`|Release ${String(index)}>`)).toHaveLength(2);
      }
      expect(texts.join('\n').indexOf('Release 0>')).toBeLessThan(
        texts.join('\n').indexOf('Release 11>'),
      );
    });

    it('labels only the first section of a split group, and puts no divider inside it', () => {
      const items = Array.from({ length: 6 }, (_, index) =>
        item({ title: `R${String(index)}`, whatChanged: 'x'.repeat(900) }),
      );
      const { blocks } = toSlackBlocks(view({ groups: [group('act-now', items)] }));

      const texts = sections({ text: '', blocks });
      expect(texts.length).toBeGreaterThan(1);
      expect(texts[0]?.startsWith('*🔴 Act now*\n')).toBe(true);
      for (const text of texts.slice(1)) expect(text.startsWith('•')).toBe(true);
      expect(blocks.some((block) => block.type === 'divider')).toBe(false);
    });

    it('keeps one item with enormous fields inside a single section', () => {
      const huge = 'x&<>'.repeat(5000);
      const message = toSlackBlocks(
        view({
          groups: [
            group('act-now', [item({ title: huge, whatChanged: huge, action: huge })], huge),
          ],
        }),
      );

      const texts = sections(message);
      expect(texts).toHaveLength(1);
      expect(texts[0]!.length).toBeLessThanOrEqual(SECTION_LIMIT);
      // Cutting after escaping must not leave half an entity behind.
      expect(texts[0]).not.toMatch(/&(?!amp;|lt;|gt;)/);
      // Each field is cut to its budget and keeps real text, not just the ellipsis.
      const fields = /^• \*<[^|]+\|(.*)>\*: (.*)\n→ (.*)$/.exec(
        texts[0]!.split('\n').slice(1).join('\n'),
      );
      expect(fields).not.toBeNull();
      for (const field of fields!.slice(1)) {
        expect(field.length).toBeGreaterThan(100);
        expect(field.startsWith('x&amp;&lt;&gt;x&amp;')).toBe(true);
        expect(field.endsWith('...')).toBe(true);
      }
    });

    it('keeps most of a text that is mostly characters that need escaping', () => {
      const message = toSlackBlocks(
        view({ groups: [group('act-now', [item({ whatChanged: 'a&'.repeat(600) })])] }),
      );

      const whatChanged = sections(message)[0]!.split(': ').slice(1).join(': ');
      expect(whatChanged.length).toBeGreaterThan(800);
      expect(whatChanged.length).toBeLessThanOrEqual(1000);
      expect(whatChanged.startsWith('a&amp;a&amp;')).toBe(true);
    });

    it('cuts a very long headline to what a context block can hold', () => {
      const message = toSlackBlocks(view({ headline: 'word '.repeat(2000) }));

      const context = blockAt(message, 1, 'context');
      expect(context.elements[0]?.text.length).toBeLessThanOrEqual(SECTION_LIMIT);
      expect(message.text.length).toBeLessThan(SECTION_LIMIT);
    });

    const footer = {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: 'Guards off: granite.' }],
    };

    it('fills exactly 50 blocks without a note when the sections just fit, footer included', () => {
      // header + headline + 47 sections + footer
      const message = toSlackBlocks(
        view({ groups: [group('act-now', bigItems(47))], footer: 'Guards off: granite.' }),
      );

      expect(message.blocks).toHaveLength(BLOCK_LIMIT);
      expect(sections(message)).toHaveLength(47);
      expect(allText(message)).not.toMatch(/50 blocks/);
    });

    it('cuts one section too many, says so in the last slot before the footer, and keeps the footer', () => {
      const message = toSlackBlocks(
        view({ groups: [group('act-now', bigItems(48))], footer: 'Guards off: granite.' }),
      );

      expect(message.blocks).toHaveLength(BLOCK_LIMIT);
      expect(message.blocks.at(-1)).toEqual(footer);
      expect(blockAt(message, -2, 'context').elements[0]?.text).toMatch(/50 blocks/);
      expect(sections(message)).toHaveLength(46);
      expect(allText(message)).toContain('Release 45 ');
      expect(allText(message)).not.toContain('Release 46 ');
    });

    it('uses all 50 blocks and ends with the note when there is no footer', () => {
      const fits = toSlackBlocks(view({ groups: [group('act-now', bigItems(48))] }));
      const cut = toSlackBlocks(view({ groups: [group('act-now', bigItems(49))] }));

      expect(fits.blocks).toHaveLength(BLOCK_LIMIT);
      expect(allText(fits)).not.toMatch(/50 blocks/);
      expect(cut.blocks).toHaveLength(BLOCK_LIMIT);
      expect(blockAt(cut, -1, 'context').elements[0]?.text).toMatch(/50 blocks/);
      expect(sections(cut)).toHaveLength(47);
    });

    it('counts the dividers between groups toward the 50 blocks', () => {
      const message = toSlackBlocks(
        view({
          groups: [
            group('act-now', bigItems(20, 'A')),
            group('worth-a-look', bigItems(20, 'B'), 'Worth a look'),
            group('good-to-know', bigItems(20, 'C'), 'Good to know'),
          ],
          footer: 'Guards off: granite.',
        }),
      );

      expect(message.blocks).toHaveLength(BLOCK_LIMIT);
      expect(message.blocks.filter((block) => block.type === 'divider')).toHaveLength(2);
      expect(message.blocks.at(-1)).toEqual(footer);
      expect(blockAt(message, -2, 'context').elements[0]?.text).toMatch(/50 blocks/);
    });

    it('never goes over 50 blocks for a very large view', () => {
      const message = toSlackBlocks(
        view({ groups: [group('act-now', bigItems(200))], footer: 'Guards off: granite.' }),
      );

      expect(message.blocks).toHaveLength(BLOCK_LIMIT);
    });

    it('does not add the omission note when everything fits', () => {
      expect(allText(toSlackBlocks(view()))).not.toMatch(/50 blocks/);
    });
  });

  describe('purity', () => {
    it('does not change its input', () => {
      const frozen = deepFreeze(loadView());

      expect(() => toSlackBlocks(frozen)).not.toThrow();
    });

    it('is deterministic', () => {
      const input = loadView();

      expect(toSlackBlocks(input)).toEqual(toSlackBlocks(input));
    });

    it('produces JSON that survives a round trip, so preview can write it to slack.json', () => {
      const message = toSlackBlocks(loadView());

      expect(JSON.parse(JSON.stringify(message))).toEqual(message);
    });
  });
});
