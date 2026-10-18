import { describe, expect, it } from 'vitest';
import { buildDigestView } from './layout';
import type { Digest, DigestItem, Urgency } from '../domain/schemas';
import { makeDigest, makeDigestItem, makeItem } from '../../test/builders';

const NONE = { disabledGuards: [] } as const;

/** A digest whose items take these overrides in order; every item gets its own title and url. */
function digestOf(...overrides: Partial<DigestItem>[]): Digest {
  const base = makeDigest([]);
  return {
    ...base,
    items: overrides.map((patch) => makeDigestItem(makeItem(), patch)),
  };
}

const urgencies = (digest: Digest): Urgency[] =>
  buildDigestView(digest, NONE).groups.map((g) => g.urgency);

describe('buildDigestView groups', () => {
  it('orders groups act-now, worth-a-look, good-to-know whatever the item order', () => {
    const digest = digestOf(
      { urgency: 'good-to-know' },
      { urgency: 'act-now' },
      { urgency: 'worth-a-look' },
    );

    expect(urgencies(digest)).toEqual(['act-now', 'worth-a-look', 'good-to-know']);
  });

  it('drops groups that have no items', () => {
    const digest = digestOf({ urgency: 'good-to-know' }, { urgency: 'act-now' });

    expect(urgencies(digest)).toEqual(['act-now', 'good-to-know']);
  });

  it('keeps the writer order inside a group', () => {
    const digest = digestOf(
      { title: 'A', urgency: 'worth-a-look' },
      { title: 'B', urgency: 'act-now' },
      { title: 'C', urgency: 'worth-a-look' },
      { title: 'D', urgency: 'act-now' },
    );

    const view = buildDigestView(digest, NONE);

    expect(view.groups.map((g) => g.items.map((i) => i.title))).toEqual([
      ['B', 'D'],
      ['A', 'C'],
    ]);
  });

  it('gives each group its fixed label', () => {
    const digest = digestOf(
      { urgency: 'act-now' },
      { urgency: 'worth-a-look' },
      { urgency: 'good-to-know' },
    );

    const view = buildDigestView(digest, NONE);

    expect(view.groups.map((g) => g.label)).toEqual(['Act now', 'Worth a look', 'Good to know']);
  });
});

describe('buildDigestView items', () => {
  it('maps the title, the url and the summary as what changed', () => {
    const digest = digestOf({
      title: 'OpenTofu 1.12.8',
      url: 'https://example.com/opentofu',
      summary: 'Security fix.',
      urgency: 'act-now',
      action: 'Upgrade OpenTofu in CI.',
    });

    const [group] = buildDigestView(digest, NONE).groups;

    expect(group?.items).toEqual([
      {
        title: 'OpenTofu 1.12.8',
        url: 'https://example.com/opentofu',
        whatChanged: 'Security fix.',
        action: 'Upgrade OpenTofu in CI.',
      },
    ]);
  });

  it('reads an item without urgency as worth-a-look', () => {
    const digest = digestOf({ title: 'Old' });

    const view = buildDigestView(digest, NONE);

    expect(view.groups).toHaveLength(1);
    expect(view.groups[0]).toMatchObject({ urgency: 'worth-a-look', label: 'Worth a look' });
  });

  it.each<Urgency>(['act-now', 'worth-a-look'])(
    'falls back to why-it-matters for a %s item without an action',
    (urgency) => {
      const digest = digestOf({ urgency, whyItMatters: 'It changes the build.' });

      const [group] = buildDigestView(digest, NONE).groups;

      expect(group?.items[0]?.action).toBe('It changes the build.');
    },
  );

  it.each(['', '   ', '\n'])('treats the blank action %j as missing', (action) => {
    const digest = digestOf({ urgency: 'act-now', action, whyItMatters: 'Fallback text.' });

    const [group] = buildDigestView(digest, NONE).groups;

    expect(group?.items[0]?.action).toBe('Fallback text.');
  });

  it('leaves the action off a good-to-know item, even when the writer gave one', () => {
    const digest = digestOf(
      { urgency: 'good-to-know', action: 'Do something.' },
      { urgency: 'good-to-know' },
    );

    const [group] = buildDigestView(digest, NONE).groups;

    for (const item of group?.items ?? []) expect(item).not.toHaveProperty('action');
  });
});

describe('buildDigestView title', () => {
  const atWeek = (items: Partial<DigestItem>[], weekId = '2026-W42'): string =>
    buildDigestView({ ...digestOf(...items), weekId }, NONE).title;
  const many = (count: number, patch: Partial<DigestItem>): Partial<DigestItem>[] =>
    Array.from({ length: count }, () => patch);

  it('counts the releases and the ones that need action', () => {
    const items = [...many(1, { urgency: 'act-now' }), ...many(4, { urgency: 'worth-a-look' })];

    expect(atWeek(items)).toBe('Week 2026-W42: 5 releases, 1 needs action');
  });

  it('says "nothing needs action" when no item is act-now', () => {
    expect(atWeek(many(3, { urgency: 'good-to-know' }))).toBe(
      'Week 2026-W42: 3 releases, nothing needs action',
    );
  });

  it('says "need action" for two or more', () => {
    expect(atWeek(many(4, { urgency: 'act-now' }), '2026-W07')).toBe(
      'Week 2026-W07: 4 releases, 4 need action',
    );
  });

  it('writes "1 release" for a single item', () => {
    expect(atWeek(many(1, { urgency: 'act-now' }))).toBe(
      'Week 2026-W42: 1 release, 1 needs action',
    );
  });

  it('writes "0 releases" for no items', () => {
    expect(atWeek([])).toBe('Week 2026-W42: 0 releases, nothing needs action');
  });

  it('counts an old draft without urgency as not needing action', () => {
    expect(atWeek(many(3, {}))).toBe('Week 2026-W42: 3 releases, nothing needs action');
  });
});

describe('buildDigestView headline, week and footer', () => {
  it('passes the model headline and the week through', () => {
    const digest = { ...digestOf({}), headline: 'Runners moved', weekId: '2026-W41' };

    const view = buildDigestView(digest, NONE);

    expect(view).toMatchObject({ headline: 'Runners moved', weekId: '2026-W41' });
  });

  it('has no footer when every guard was on', () => {
    expect(buildDigestView(digestOf({}), NONE)).not.toHaveProperty('footer');
  });

  it('names the guards that were off in the footer', () => {
    const view = buildDigestView(digestOf({}), { disabledGuards: ['clefPolicy', 'graniteRisk'] });

    expect(view.footer).toBe('Guards off this week: clefPolicy, graniteRisk.');
  });
});

describe('buildDigestView purity', () => {
  it('does not change the digest it reads', () => {
    const digest = digestOf({ urgency: 'good-to-know' }, { urgency: 'act-now', action: 'Go.' });
    const frozen = structuredClone(digest);
    Object.freeze(digest);
    Object.freeze(digest.items);
    digest.items.forEach((item) => Object.freeze(item));

    buildDigestView(digest, { disabledGuards: ['clefRubric'] });

    expect(digest).toEqual(frozen);
  });

  it('returns a new view each call', () => {
    const digest = digestOf({ urgency: 'act-now' });

    expect(buildDigestView(digest, NONE)).not.toBe(buildDigestView(digest, NONE));
    expect(buildDigestView(digest, NONE)).toEqual(buildDigestView(digest, NONE));
  });
});
