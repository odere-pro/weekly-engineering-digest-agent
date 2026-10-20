// Collected and model text in the Markdown shows what it says: no invisible character in it can
// reorder or hide the text around it, in the saved digest.md, the .md file or a plain-text mail.
import { describe, expect, it } from 'vitest';
import { linkCheck } from '../checks/linkCheck';
import { renderDigest, renderView, readSavedView } from './markdown';
import { visibleText } from './visibleText';
import type { DigestItem } from '../domain/schemas';
import { makeDigest, makeDigestItem, makeItem } from '../../test/builders';
import { splitCells } from './__fixtures__/render/cells';

const NONE = { disabledGuards: [] } as const;

const RLO = '\u{202E}';
const ZWSP = '\u{200B}';
const ZWJ = '\u{200D}';
const BIDI_AND_HIDDEN = [
  RLO,
  '\u{2066}',
  '\u{061C}',
  '\u{200E}',
  ZWSP,
  '\u{2060}',
  '\u{206A}',
  '\u{FEFF}',
  '\u{00AD}',
  '\u{E0041}',
  '\u{0007}',
].join('');

/** A character that shows nothing or moves other text, as a class: control or format. */
const INVISIBLE_CLASS = '[\\p{Cc}\\p{Cf}\\u{2028}\\u{2029}\\u{E0000}-\\u{E007F}]';
// eslint-disable-next-line regexp/no-dupe-characters-character-class -- the tag block is listed whole on purpose: its unassigned code points are not Cf
const INVISIBLE = new RegExp(INVISIBLE_CLASS, 'u');
// eslint-disable-next-line regexp/no-dupe-characters-character-class -- the tag block is listed whole on purpose: its unassigned code points are not Cf
const INVISIBLE_EVERYWHERE = new RegExp(INVISIBLE_CLASS, 'gu');

/** Renders one act-now item with these overrides; returns its table row. */
function rowOf(patch: Partial<DigestItem>): string[] {
  const item = makeDigestItem(makeItem(), { urgency: 'act-now', action: 'Go.', ...patch });
  const markdown = renderDigest({ ...makeDigest([]), items: [item] }, NONE);
  const rows = markdown.split('\n').filter((line) => line.startsWith('| ['));
  expect(rows).toHaveLength(1);
  return splitCells(rows[0]!);
}

describe.each([
  ['a bidi override', RLO],
  ['a bidi isolate', '\u{2066}'],
  ['the Arabic letter mark', '\u{061C}'],
  ['a left-to-right mark', '\u{200E}'],
  ['a zero-width space', ZWSP],
  ['a zero-width non-joiner', '\u{200C}'],
  ['a word joiner', '\u{2060}'],
  ['a deprecated format control', '\u{206A}'],
  ['the byte order mark', '\u{FEFF}'],
  ['a soft hyphen', '\u{00AD}'],
  ['a tag character', '\u{E0041}'],
  ['a bell', '\u{0007}'],
])('%s in a cell', (_name, hidden) => {
  const written = `Fix${hidden}ed`;

  it('becomes a space in the title', () => {
    expect(rowOf({ title: written, url: 'https://example.com/p' })[0]).toBe(
      ' [Fix ed](https://example.com/p) ',
    );
  });

  it('becomes a space in what changed and in the action', () => {
    expect(rowOf({ summary: written, action: written })).toEqual([
      expect.any(String),
      ' Fix ed ',
      ' Fix ed ',
    ]);
  });

  it('becomes a space in the headline', () => {
    const item = makeDigestItem(makeItem(), { urgency: 'act-now', action: 'Go.' });
    const digest = { ...makeDigest([]), headline: written, items: [item] };

    expect(renderDigest(digest, NONE).split('\n')[2]).toBe('_Fix ed_');
  });
});

describe('a Markdown full of invisible characters', () => {
  const hostile = (text: string): string => `${BIDI_AND_HIDDEN}${text}${BIDI_AND_HIDDEN}`;
  const digest = {
    ...makeDigest([]),
    headline: hostile('Headline'),
    items: [
      makeDigestItem(makeItem(), {
        title: hostile('Act'),
        summary: hostile('Changed'),
        action: hostile('Upgrade'),
        urgency: 'act-now',
      }),
      makeDigestItem(makeItem({ url: 'https://example.com/b' }), {
        url: 'https://example.com/b',
        title: hostile('Look'),
        summary: hostile('Moved'),
        action: hostile('Run it'),
        urgency: 'worth-a-look',
      }),
      makeDigestItem(makeItem({ url: 'https://example.com/c' }), {
        url: 'https://example.com/c',
        title: hostile('Know'),
        summary: hostile('Shipped'),
        urgency: 'good-to-know',
      }),
    ],
  };

  it('has no control or format character left but the line breaks', () => {
    const markdown = renderDigest(digest, NONE);

    expect(markdown.replaceAll('\n', '')).not.toMatch(INVISIBLE);
  });

  it('reads the same as the Markdown of the text with spaces where they were', () => {
    const spaced = (text: string): string => text.replace(INVISIBLE_EVERYWHERE, ' ');
    const plain = {
      ...digest,
      headline: spaced(digest.headline),
      items: digest.items.map((item) => ({
        ...item,
        title: spaced(item.title),
        summary: spaced(item.summary),
        ...(item.action === undefined ? {} : { action: spaced(item.action) }),
      })),
    };

    expect(renderDigest(digest, NONE)).toBe(renderDigest(plain, NONE));
  });

  it('renders back to the very same Markdown after it is read back, as a resume needs', () => {
    const markdown = renderDigest(digest, NONE);
    const view = readSavedView(markdown);

    expect(view).toBeDefined();
    expect(renderView(view!)).toBe(markdown);
    expect(view?.headline).toBe('Headline');
    expect(view?.groups.map((group) => group.items[0]?.title)).toEqual(['Act', 'Look', 'Know']);
  });

  it('is left as it is by visibleText, so the channels that clean it again change nothing', () => {
    const markdown = renderDigest(digest, NONE);

    expect(visibleText(markdown)).toBe(markdown);
  });

  it('passes the link and format work of a clean digest: the urls are untouched', () => {
    const markdown = renderDigest(digest, NONE);
    const collected = digest.items.map((item) => makeItem({ url: item.url }));

    expect(linkCheck(digest, markdown, collected)).toEqual({ ok: true, problems: [] });
  });
});

describe('a joiner in a cell', () => {
  const TECHNOLOGIST = `\u{1F469}${ZWJ}\u{1F4BB}`;

  it('stays between two emoji, so a joined emoji shows whole', () => {
    expect(rowOf({ summary: `Shipped by ${TECHNOLOGIST} today` })[1]).toBe(
      ` Shipped by ${TECHNOLOGIST} today `,
    );
  });

  it('goes anywhere else', () => {
    expect(rowOf({ summary: `con${ZWJ}nect` })[1]).toBe(' con nect ');
  });
});

describe('a url with an invisible character', () => {
  const hiddenUrl = `https://example.com/a${RLO}b`;

  it('is shown without it, so the destination cannot read in another order', () => {
    const [release] = rowOf({ url: hiddenUrl, title: 'Tool' });

    expect(release).not.toMatch(INVISIBLE);
  });

  it('no longer links the url the model wrote: the link check rejects the digest', () => {
    const item = makeDigestItem(makeItem({ url: 'https://example.com/a%E2%80%AEb' }), {
      url: hiddenUrl,
      urgency: 'act-now',
      action: 'Go.',
    });
    const digest = { ...makeDigest([]), items: [item] };
    const markdown = renderDigest(digest, NONE);

    const result = linkCheck(digest, markdown, [
      makeItem({ url: 'https://example.com/a%E2%80%AEb' }),
    ]);

    expect(result.ok).toBe(false);
  });
});

describe('text without an invisible character', () => {
  it('renders as it did: a blank title shows the url, a pipe is escaped, indentation is one space', () => {
    expect(rowOf({ title: ' \n ', url: 'https://example.com/p' })[0]).toBe(
      ' [https://example.com/p](https://example.com/p) ',
    );
    expect(rowOf({ summary: 'a | b' })[1]).toBe(' a \\| b ');
    expect(rowOf({ summary: 'one \t  two' })[1]).toBe(' one two ');
  });
});
