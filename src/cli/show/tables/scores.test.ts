import { describe, expect, it } from 'vitest';
import { digestItemIds, scoresTable } from './scores';
import { ShowError } from '../showError';
import { makeClassification, makeDraft, makeItem, makeRunRecord } from '../../../../test/builders';
import { MemoryRunStore } from '../../../../test/fakes';

const WEEK = '2026-W42';

const picked = makeItem({ id: 'a', title: 'Picked release' });
const spare = makeItem({ id: 'b', title: 'Spare release' });
const blocked = makeItem({ id: 'c', title: 'Blocked release' });

const scores = [
  makeClassification('a', {
    relevance: 3,
    area: 'Platform',
    areaConfidence: 0.9,
    hype: 0.1,
    minorRelease: 0.25,
  }),
  makeClassification('b', {
    relevance: 1.25,
    area: 'AI',
    areaConfidence: 0.456,
    hype: 0.5,
    minorRelease: 0.005,
  }),
];
const scoresRaw = JSON.stringify(scores);

function seeded(options: { winner?: string | null; withItems?: boolean } = {}): MemoryRunStore {
  const store = new MemoryRunStore();
  store.records.set(
    WEEK,
    makeRunRecord({ runId: WEEK, winner: options.winner === undefined ? 'w1' : options.winner }),
  );
  store.artifacts.set(
    `${WEEK}/drafts.json`,
    JSON.stringify({ drafts: [makeDraft([picked], 'w1')] }),
  );
  if (options.withItems !== false) {
    store.artifacts.set(`${WEEK}/items.json`, JSON.stringify([picked, spare, blocked]));
  }
  return store;
}

describe('scoresTable', () => {
  it('prints one row per score, then the items the input guard dropped', async () => {
    const text = await scoresTable(WEEK, scoresRaw, seeded());
    expect(text).toBe(
      [
        'Item             Relevance  Area            Hype  Minor  Status',
        'Picked release   3.0        Platform (90%)  10%   25%    in digest',
        'Spare release    1.3        AI (46%)        50%   1%     scored, not picked',
        'Blocked release  -          -               -     -      dropped before scoring (input guard)',
        '',
      ].join('\n'),
    );
  });

  it('shows the item id when items.json is missing, and drops nothing', async () => {
    const text = await scoresTable(WEEK, scoresRaw, seeded({ withItems: false }));
    const rows = text.split('\n');
    expect(rows).toHaveLength(4);
    expect(rows[1]).toMatch(/^a {2,}3\.0/);
    expect(rows[2]).toMatch(/^b {2,}1\.3/);
    expect(text).not.toContain('dropped');
  });

  it('marks every row "scored, not picked" when the run has no winner', async () => {
    const text = await scoresTable(WEEK, scoresRaw, seeded({ winner: null }));
    expect(text).not.toContain('in digest');
    expect(text.match(/scored, not picked/g)).toHaveLength(2);
  });

  it('prints only the header for an empty scores file and no items', async () => {
    const text = await scoresTable(WEEK, '[]', seeded({ withItems: false }));
    expect(text).toBe('Item  Relevance  Area  Hype  Minor  Status\n');
  });

  it('turns control characters in a title into spaces', async () => {
    const store = seeded();
    const dirty = makeItem({ id: 'a', title: 'Bad\u001b[2Jtitle' });
    store.artifacts.set(`${WEEK}/items.json`, JSON.stringify([dirty]));
    const text = await scoresTable(WEEK, scoresRaw, store);
    expect(text).not.toContain('\u001b');
    expect(text).toContain('Bad [2Jtitle');
  });

  it('names scores.json when it does not have the expected shape', async () => {
    await expect(scoresTable(WEEK, '[{"itemId": 1}]', seeded())).rejects.toThrow(
      'scores.json does not have the expected shape',
    );
  });

  it('names items.json when it is not valid JSON', async () => {
    const store = seeded();
    store.artifacts.set(`${WEEK}/items.json`, '{nope');
    await expect(scoresTable(WEEK, scoresRaw, store)).rejects.toThrow(/^items\.json is not valid/);
  });
});

describe('digestItemIds', () => {
  it('returns the item ids of the winning draft only', async () => {
    const store = seeded({ winner: 'w2' });
    store.artifacts.set(
      `${WEEK}/drafts.json`,
      JSON.stringify({ drafts: [makeDraft([picked], 'w1'), makeDraft([spare, blocked], 'w2')] }),
    );
    expect([...(await digestItemIds(WEEK, store))].sort()).toEqual(['b', 'c']);
  });

  it('is empty when the run has no record', async () => {
    expect((await digestItemIds(WEEK, new MemoryRunStore())).size).toBe(0);
  });

  it('is empty when the run has no winner', async () => {
    expect((await digestItemIds(WEEK, seeded({ winner: null }))).size).toBe(0);
  });

  it('is empty when drafts.json is missing', async () => {
    const store = seeded();
    store.artifacts.delete(`${WEEK}/drafts.json`);
    expect((await digestItemIds(WEEK, store)).size).toBe(0);
  });

  it('is empty when no draft belongs to the winner', async () => {
    expect((await digestItemIds(WEEK, seeded({ winner: 'someone-else' }))).size).toBe(0);
  });

  it('throws a ShowError naming drafts.json when it cannot be read', async () => {
    const store = seeded();
    store.artifacts.set(`${WEEK}/drafts.json`, '{"drafts": 5}');
    const attempt = digestItemIds(WEEK, store);
    await expect(attempt).rejects.toThrow(ShowError);
    await expect(attempt).rejects.toThrow('drafts.json does not have the expected shape');
  });
});
