import { describe, expect, it } from 'vitest';
import { factCarry, factsOfWeek } from './factCarry';
import type { DigestSample } from './digestSample';
import { MAX_PROBLEM_CHARS, MAX_PROBLEMS_PER_WEEK } from '../measurement/weekDetail';
import { renderDigest } from '../../../src/render/markdown';
import type { DigestItem, Item } from '../../../src/domain/schemas';
import { makeDigest, makeDigestItem, makeItem } from '../../../test/builders';

const ALL_LAYERS = ['linkCheck', 'formatCheck', 'graniteGroundedness', 'clefRubric'];

/** A collected item and the digest item written from it (the written fields override). */
interface Entry {
  source: Item;
  written?: Partial<DigestItem>;
}

const entry = (source: Item, written?: Partial<DigestItem>): Entry => ({
  source,
  ...(written === undefined ? {} : { written }),
});

function sampleFor(
  entries: readonly Entry[],
  extra: Partial<DigestSample> = {},
  weekId = '2026-W42',
): DigestSample {
  const digest = {
    ...makeDigest([], { weekId }),
    items: entries.map(({ source, written }) => makeDigestItem(source, written)),
  };
  const markdown = renderDigest(digest, { disabledGuards: [] });
  return { weekId, markdown, items: entries.map(({ source }) => source), ...extra };
}

const noDigest = (weekId: string, items: readonly Item[] = []): DigestSample => ({
  weekId,
  markdown: undefined,
  items,
});

const release = makeItem({ title: 'tool v1.2.0', summary: 'Shipped on 2026-10-19.' });

describe('factsOfWeek', () => {
  const sample = (entries: readonly Entry[], extra: Partial<DigestSample> = {}) => {
    const built = sampleFor(entries, extra);
    return factsOfWeek({ ...built, markdown: built.markdown ?? '' });
  };

  it('lists a wrong version in the title with its field, token and the layers it passed', () => {
    const facts = sample([entry(release, { title: 'tool v1.3.0' })]);

    expect(facts.misses).toEqual([
      {
        weekId: '2026-W42',
        itemTitle: 'tool v1.3.0',
        field: 'title',
        token: '1.3.0',
        passedBy: ALL_LAYERS,
      },
    ]);
    expect(facts).toMatchObject({ checked: 1, clean: 0, skipped: 0 });
  });

  it('checks the title, the summary and the action each on its own', () => {
    const facts = sample([
      entry(release, {
        title: 'tool v1.3.0',
        summary: 'Fixes CVE-2026-9999.',
        urgency: 'act-now',
        action: 'Upgrade to v9.9.9 today.',
      }),
    ]);

    expect(facts.misses.map(({ field, token }) => [field, token])).toEqual([
      ['title', '1.3.0'],
      ['summary', 'cve-2026-9999'],
      ['action', '9.9.9'],
    ]);
    expect(facts).toMatchObject({ checked: 1, clean: 0 });
  });

  it('counts an item once however many facts it gets wrong', () => {
    const facts = sample([
      entry(release, { title: 'tool v1.3.0', summary: 'Moves from 7.0.0 to 8.0.0.' }),
    ]);

    expect(facts.misses).toHaveLength(3);
    expect(facts).toMatchObject({ checked: 1, clean: 0 });
  });

  it('leaves a disabled output guard out of the layers a miss got past', () => {
    const facts = sample([entry(release, { title: 'tool v1.3.0' })], {
      disabledGuards: ['graniteGroundedness'],
    });

    expect(facts.misses[0]?.passedBy).toEqual(['linkCheck', 'formatCheck', 'clefRubric']);
  });

  it('names only the code checks when both output guards were off', () => {
    const facts = sample([entry(release, { title: 'tool v1.3.0' })], {
      disabledGuards: ['graniteGroundedness', 'clefRubric'],
    });

    expect(facts.misses[0]?.passedBy).toEqual(['linkCheck', 'formatCheck']);
  });

  it('does not count an input guard as a layer the digest passed', () => {
    const facts = sample([entry(release, { title: 'tool v1.3.0' })], {
      disabledGuards: ['ruleInjection', 'clefPolicy', 'graniteRisk'],
    });

    expect(facts.misses[0]?.passedBy).toEqual(ALL_LAYERS);
  });

  it('checks two digest items that link the same source one by one', () => {
    const facts = sample([entry(release), entry(release, { title: 'tool v1.3.0' })]);

    expect(facts).toMatchObject({ checked: 2, clean: 1 });
    expect(facts.misses).toHaveLength(1);
  });

  it('does not check an action the layout does not print for a good-to-know item', () => {
    const facts = sample([
      entry(release, { urgency: 'good-to-know', action: 'Upgrade to v9.9.9 today.' }),
    ]);

    expect(facts).toMatchObject({ checked: 1, clean: 1, misses: [] });
  });

  it('skips an item whose link no collected item has, and counts it', () => {
    const stranger = makeItem({ title: 'other v9.9.9' });
    const built = sampleFor([entry(release), entry(stranger)]);

    const facts = factsOfWeek({
      ...built,
      markdown: built.markdown ?? '',
      items: [release],
    });

    expect(facts).toMatchObject({ checked: 1, clean: 1, skipped: 1, misses: [] });
  });
});

describe('factCarry', () => {
  it('is 1 when every version, id and date of the digest is in its source', () => {
    const second = makeItem({ title: 'lib 2.0.0', summary: 'Fixes CVE-2026-1111.' });

    const result = factCarry([
      sampleFor([
        entry(release),
        entry(second, { summary: 'Patches CVE-2026-1111 in lib 2.0.0.' }),
      ]),
    ]);

    expect(result.value).toBe(1);
    expect(result.byWeek).toEqual({ '2026-W42': { status: 'ok', problems: [], problemCount: 0 } });
    expect(result.note).toBeUndefined();
  });

  it('reads v1.2.0 in the digest and 1.2.0 in the source as the same version', () => {
    const source = makeItem({ title: 'Release 1.2.0', summary: '' });

    const result = factCarry([sampleFor([entry(source, { title: 'tool v1.2.0' })])]);

    expect(result.value).toBe(1);
  });

  it('accepts a date that is in the source', () => {
    const result = factCarry([sampleFor([entry(release, { summary: 'Out on 2026-10-19.' })])]);

    expect(result.value).toBe(1);
  });

  it('is the share of shipped items without a missing fact', () => {
    const clean = makeItem({ title: 'lib 2.0.0' });
    const other = makeItem({ title: 'cli 3.1.0' });

    const result = factCarry([
      sampleFor([entry(release, { title: 'tool v1.3.0' }), entry(clean), entry(other)]),
      sampleFor([entry(makeItem({ title: 'app 4.0.0' }))], {}, '2026-W43'),
    ]);

    expect(result.value).toBe(0.75);
  });

  it('names the miss of a week with its field, token and layers', () => {
    const result = factCarry([
      sampleFor([entry(release)], {}, '2026-W41'),
      sampleFor([entry(release, { title: 'tool v1.3.0' })], {}, '2026-W42'),
    ]);

    expect(result.byWeek?.['2026-W41']?.status).toBe('ok');
    const week = result.byWeek?.['2026-W42'];
    expect(week).toMatchObject({ status: 'failed', problemCount: 1 });
    expect(week?.problems[0]).toBe(
      'title of "tool v1.3.0": 1.3.0 is not in its source; got past ' + ALL_LAYERS.join(', '),
    );
  });

  it('skips an item with a link nobody collected and says so in the note', () => {
    const stranger = makeItem({ title: 'other v9.9.9' });
    const built = sampleFor([entry(release), entry(stranger)]);

    const result = factCarry([{ ...built, items: [release] }]);

    expect(result.value).toBe(1);
    expect(result.note).toBe('skipped: 1 item whose link matches no collected item');
  });

  it('skips a week without a digest, shows it in the week detail and names it in the note', () => {
    const result = factCarry([
      sampleFor([entry(release)], {}, '2026-W41'),
      { ...noDigest('2026-W40'), cause: 'run ended as "quiet"' },
    ]);

    expect(result.value).toBe(1);
    expect(result.byWeek?.['2026-W40']).toEqual({
      status: 'no-digest',
      problems: ['run ended as "quiet"'],
      problemCount: 1,
    });
    expect(result.note).toBe('skipped: no digest in 2026-W40');
  });

  it('names every skipped part in one note', () => {
    const stranger = makeItem({ title: 'other v9.9.9' });
    const built = sampleFor([entry(release), entry(stranger), entry(stranger)]);

    const result = factCarry([
      { ...built, items: [release] },
      noDigest('2026-W39'),
      noDigest('2026-W38'),
    ]);

    expect(result.note).toBe(
      'skipped: no digest in 2026-W39, 2026-W38; 2 items whose link matches no collected item',
    );
  });

  it('is not measured when there is nothing to check', () => {
    expect(factCarry([]).value).toBeNull();
    expect(factCarry([noDigest('2026-W40')]).value).toBeNull();
    const stranger = sampleFor([entry(makeItem())]);
    expect(factCarry([{ ...stranger, items: [] }]).value).toBeNull();
  });

  it('has no weeks to show without samples', () => {
    expect(factCarry([])).toEqual({ value: null });
  });

  it('numbers a repeated week, so no replay is lost from the detail', () => {
    const result = factCarry([
      sampleFor([entry(release)]),
      sampleFor([entry(release, { title: 'tool v1.3.0' })]),
    ]);

    expect(Object.keys(result.byWeek ?? {})).toEqual(['2026-W42', '2026-W42 (2)']);
    expect(result.byWeek?.['2026-W42 (2)']?.status).toBe('failed');
    expect(result.value).toBe(0.5);
  });

  it('keeps the first problems of a week and counts them all', () => {
    const versions = Array.from({ length: MAX_PROBLEMS_PER_WEEK + 2 }, (_, i) => `${i + 5}.0.0`);

    const result = factCarry([
      sampleFor([entry(release, { summary: `Mentions ${versions.join(' ')}.` })]),
    ]);

    const week = result.byWeek?.['2026-W42'];
    expect(week?.problems).toHaveLength(MAX_PROBLEMS_PER_WEEK);
    expect(week?.problemCount).toBe(MAX_PROBLEMS_PER_WEEK + 2);
  });

  it.each([
    ['title', { title: `tool v${'9'.repeat(5_000)}.0 ${'word '.repeat(400)}` }],
    ['summary', { title: 'word '.repeat(400), summary: `Moves to v${'9'.repeat(5_000)}.0.` }],
  ] as const)(
    'cuts the title and the fact of a %s miss but keeps the layers that let it through',
    (field, written) => {
      const result = factCarry([sampleFor([entry(release, written)])]);

      const [problem] = result.byWeek?.['2026-W42']?.problems ?? [];
      expect(problem).toBeDefined();
      expect(problem?.length).toBeLessThanOrEqual(MAX_PROBLEM_CHARS);
      expect(problem?.startsWith(`${field} of "`)).toBe(true);
      expect(problem?.endsWith(`got past ${ALL_LAYERS.join(', ')}`)).toBe(true);
    },
  );

  it('stays fast on a hostile title', () => {
    const started = performance.now();

    const result = factCarry([sampleFor([entry(release, { title: '9'.repeat(100_000) })])]);

    expect(performance.now() - started).toBeLessThan(2_000);
    expect(result.value).toBe(1);
  });
});
