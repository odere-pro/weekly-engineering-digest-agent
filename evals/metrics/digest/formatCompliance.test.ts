import { describe, expect, it } from 'vitest';
import { formatCompliance } from './formatCompliance';
import type { DigestSample } from './digestSample';
import { parseDigestMarkdown } from './parseDigest';
import { MAX_PROBLEMS_PER_WEEK } from '../measurement/weekDetail';
import { DIGEST_ACTION_WORD_LIMIT, formatCheck } from '../../../src/checks/formatCheck';
import { renderDigest } from '../../../src/render/markdown';
import type { Item } from '../../../src/domain/schemas';
import { makeDigest, makeDigestItem, makeItem } from '../../../test/builders';

const makeItems = (count: number): Item[] => Array.from({ length: count }, () => makeItem());

function sampleFor(
  items: readonly Item[],
  digestItems: readonly Item[] = items,
  weekId = '2026-W42',
): DigestSample {
  const markdown = renderDigest(makeDigest(digestItems, { weekId }), { disabledGuards: [] });
  return { weekId, markdown, items };
}

describe('formatCompliance', () => {
  it('is 1 when every digest has 3-5 items and no em dash', () => {
    expect(formatCompliance([sampleFor(makeItems(3)), sampleFor(makeItems(5))]).value).toBe(1);
  });

  it('fails a digest with too few or too many items', () => {
    const result = formatCompliance([
      sampleFor(makeItems(2)),
      sampleFor(makeItems(6)),
      sampleFor(makeItems(4)),
    ]);
    expect(result.value).toBeCloseTo(1 / 3);
  });

  it('fails a digest with an em dash', () => {
    const items = makeItems(3);
    const markdown = `${renderDigest(makeDigest(items), { disabledGuards: [] })}\nBig — news.\n`;
    expect(formatCompliance([{ weekId: '2026-W42', markdown, items }]).value).toBe(0);
  });

  it('counts a week without a digest as a failure', () => {
    const items = makeItems(3);
    const none: DigestSample = { weekId: '2026-W41', markdown: undefined, items };
    expect(formatCompliance([sampleFor(items), none]).value).toBe(0.5);
  });

  it('is null with no weeks', () => {
    expect(formatCompliance([]).value).toBeNull();
  });
});

describe('the format check on a digest read back', () => {
  it('names the problems that formatCompliance leaves out, so a rewording of them is noticed', () => {
    const digest = makeDigest(makeItems(3));

    const { problems } = formatCheck(
      { ...digest, intro: '', items: digest.items.map((i) => ({ ...i, whyItMatters: '' })) },
      '',
    );

    expect(problems).toEqual(
      expect.arrayContaining([
        'Missing intro',
        'Missing why-it-matters in item 1',
        'Missing why-it-matters in item 3',
      ]),
    );
  });

  it('does not fail a digest for the intro and why-it-matters lines the layout leaves out', () => {
    const items = makeItems(3);
    const markdown = renderDigest(makeDigest(items), { disabledGuards: [] });

    const result = formatCompliance([{ weekId: '2026-W42', markdown, items }]);

    expect(result.value).toBe(1);
    expect(result.byWeek?.['2026-W42']).toEqual({ status: 'ok', problems: [], problemCount: 0 });
  });

  it('still fails a digest whose action line is over the limit', () => {
    const items = makeItems(3);
    const long = 'word '.repeat(DIGEST_ACTION_WORD_LIMIT + 1).trim();
    const digest = {
      ...makeDigest([]),
      items: items.map((item) => makeDigestItem(item, { urgency: 'act-now', action: long })),
    };
    const markdown = renderDigest(digest, { disabledGuards: [] });

    const result = formatCompliance([{ weekId: '2026-W42', markdown, items }]);

    expect(result.value).toBe(0);
    expect(result.byWeek?.['2026-W42']?.problems[0]).toContain('words in the action of item 1');
  });
});

describe('formatCompliance without a digest', () => {
  it('gives each week without a digest its own detail', () => {
    const items = makeItems(3);
    const none = (weekId: string): DigestSample => ({ weekId, markdown: undefined, items });

    const result = formatCompliance([none('2026-W40'), none('2026-W41')]);

    expect(result.byWeek?.['2026-W40']).not.toBe(result.byWeek?.['2026-W41']);
  });
});

describe('formatCompliance by week', () => {
  it('names what the format check found wrong with each failing week', () => {
    const result = formatCompliance([
      sampleFor(makeItems(4), undefined, '2026-W40'),
      sampleFor(makeItems(2), undefined, '2026-W41'),
    ]);

    expect(result.byWeek?.['2026-W40']).toEqual({ status: 'ok', problems: [], problemCount: 0 });
    expect(result.byWeek?.['2026-W41']).toMatchObject({
      status: 'failed',
      problems: ['Expected 3-5 items, got 2'],
      problemCount: 1,
    });
  });

  it('marks a week without a digest, which still counts as a failure in the value', () => {
    const items = makeItems(3);
    const none: DigestSample = { weekId: '2026-W41', markdown: undefined, items };

    const result = formatCompliance([sampleFor(items, items, '2026-W40'), none]);

    expect(result.byWeek?.['2026-W41']?.status).toBe('no-digest');
    expect(result.value).toBe(0.5);
  });

  it('keeps only the first few problems of a week and counts them all', () => {
    const items = makeItems(5);
    const digest = makeDigest(items, { weekId: '2026-W40', headline: '', intro: '' });
    const emptyBodies = {
      ...digest,
      items: digest.items.map((entry) => ({ ...entry, summary: '', whyItMatters: '' })),
    };
    const markdown = renderDigest(emptyBodies, { disabledGuards: [] });
    // The file shows no intro and no why-it-matters line, so the check does not ask for them.
    const all = [
      'Missing headline',
      ...[1, 2, 3, 4, 5].map((position) => `Missing summary in item ${position}`),
      'Missing action in items 1, 2, 3, 4, 5',
    ];
    const asked = formatCheck(parseDigestMarkdown(markdown, '2026-W40', items), markdown).problems;
    expect(asked).toEqual(expect.arrayContaining(all));
    expect(all.length).toBeGreaterThan(MAX_PROBLEMS_PER_WEEK);

    const result = formatCompliance([{ weekId: '2026-W40', markdown, items }]);

    const week = result.byWeek?.['2026-W40'];
    expect(week?.problemCount).toBe(all.length);
    expect(week?.problems).toEqual(all.slice(0, MAX_PROBLEMS_PER_WEEK));
    expect(week?.problems[0]).toBe('Missing headline');
  });
});

describe('formatCompliance names the cause of a week without a digest', () => {
  it('puts the cause in the problems', () => {
    const measurement = formatCompliance([
      { weekId: '2026-W36', markdown: undefined, items: [], cause: 'blocked by clefRubric' },
      { weekId: '2026-W37', markdown: undefined, items: [] },
    ]);
    expect(measurement.byWeek?.['2026-W36']).toEqual({
      status: 'no-digest',
      problems: ['blocked by clefRubric'],
      problemCount: 1,
    });
    expect(measurement.byWeek?.['2026-W37']).toEqual({
      status: 'no-digest',
      problems: [],
      problemCount: 0,
    });
  });
});
