import { describe, expect, it } from 'vitest';
import { canonicalClaimText, canonicalDigestText, canonicalHeadlineText } from './canonical';
import { renderDigest } from './markdown';
import { makeDigest, makeDigestItem, makeItem } from '../../test/builders';

const items = [
  makeItem({ id: 'a', title: 'Alpha 1.0', url: 'https://example.com/a' }),
  makeItem({ id: 'b', title: 'Beta 2.0', url: 'https://example.com/b' }),
  makeItem({ id: 'c', title: 'Gamma 3.0', url: 'https://example.com/c' }),
];
const digest = makeDigest(items, {
  headline: 'Three releases',
  intro: 'Worth a look.',
});

describe('canonicalDigestText', () => {
  it('matches the golden text for a three-item digest', () => {
    const text = canonicalDigestText({
      ...digest,
      items: digest.items.map((entry, i) =>
        makeDigestItem(items[i]!, {
          area: 'Area X',
          summary: `Summary ${i + 1}.`,
          whyItMatters: `Why ${i + 1}.`,
        }),
      ),
    });

    expect(text).toBe(
      [
        'Headline: Three releases',
        'Intro: Worth a look.',
        'Title: Alpha 1.0\nArea: Area X\nSummary: Summary 1.\nWhy it matters: Why 1.\nURL: https://example.com/a',
        'Title: Beta 2.0\nArea: Area X\nSummary: Summary 2.\nWhy it matters: Why 2.\nURL: https://example.com/b',
        'Title: Gamma 3.0\nArea: Area X\nSummary: Summary 3.\nWhy it matters: Why 3.\nURL: https://example.com/c',
      ].join('\n\n'),
    );
  });

  it('holds every field of every item exactly once, in item order', () => {
    const distinct = makeDigest(items, {
      headline: 'Three releases',
      intro: 'Worth a look.',
    });
    const unique = {
      ...distinct,
      items: items.map((item, i) =>
        makeDigestItem(item, {
          area: `area-${i}`,
          summary: `summary-${i}`,
          whyItMatters: `why-${i}`,
        }),
      ),
    };
    const text = canonicalDigestText(unique);

    for (const entry of unique.items) {
      for (const field of [entry.title, entry.area, entry.summary, entry.whyItMatters, entry.url]) {
        expect(text.split(field)).toHaveLength(2);
      }
    }
    expect(text.indexOf('Alpha 1.0')).toBeLessThan(text.indexOf('Beta 2.0'));
    expect(text.indexOf('Beta 2.0')).toBeLessThan(text.indexOf('Gamma 3.0'));
  });

  it('is plain text: no Markdown heading, emphasis, link or footer, and no week id', () => {
    const text = canonicalDigestText(digest);

    expect(text).not.toMatch(/^#/m);
    expect(text).not.toContain('**');
    expect(text).not.toContain('](');
    expect(text).not.toContain(digest.weekId);
    expect(text).not.toBe(renderDigest(digest, { disabledGuards: [] }));
  });

  it('takes no options, so the render options cannot reach it', () => {
    expect(canonicalDigestText.length).toBe(1);
    expect(canonicalDigestText(digest)).toBe(canonicalDigestText(digest));
  });

  it('shares its claim and headline helpers with the groundedness guard', () => {
    const text = canonicalDigestText(digest);

    expect(canonicalHeadlineText(digest)).toBe('Three releases\nWorth a look.');
    for (const entry of digest.items) {
      expect(canonicalClaimText(entry)).toBe(`${entry.summary}\n${entry.whyItMatters}`);
      expect(text).toContain(entry.summary);
    }
  });
});

describe('canonical text and invisible characters', () => {
  it("keeps the writer's characters as written, so the guards and the judge see what was hidden", () => {
    const item = makeDigestItem(makeItem({ url: 'https://example.com/a' }), {
      title: 'Alpha\u{202E}1.0',
      summary: 'Ships\u{200B}now.',
      action: 'Upgrade\u{E0041}today.',
    });
    const hostile = {
      ...makeDigest([]),
      headline: 'Head\u{FEFF}line',
      intro: 'In\u{061C}tro.',
      items: [item],
    };

    const text = canonicalDigestText(hostile);

    for (const hidden of ['\u{202E}', '\u{200B}', '\u{E0041}', '\u{FEFF}', '\u{061C}']) {
      expect(text).toContain(hidden);
    }
    expect(canonicalClaimText(item)).toContain('\u{200B}');
    expect(canonicalHeadlineText(hostile)).toContain('\u{FEFF}');
  });

  it('does not follow the Markdown, which shows the same item without them', () => {
    const item = makeDigestItem(makeItem(), { summary: 'Ships\u{200B}now.', urgency: 'act-now' });
    const hostile = { ...makeDigest([]), items: [item] };

    expect(renderDigest(hostile, { disabledGuards: [] })).not.toContain('\u{200B}');
    expect(canonicalDigestText(hostile)).toContain('\u{200B}');
  });
});
