import { describe, expect, it } from 'vitest';
import { draftsTable } from './drafts';
import { ShowError } from '../showError';
import { makeDraft, makeItem, makeRunRecord } from '../../../../test/builders';
import { MemoryRunStore } from '../../../../test/fakes';

const WEEK = '2026-W42';

const one = makeItem({ id: 'a' });
const two = makeItem({ id: 'b' });

function storeWith(outcomes: Parameters<typeof makeRunRecord>[0] = {}): MemoryRunStore {
  const store = new MemoryRunStore();
  store.records.set(WEEK, makeRunRecord({ runId: WEEK, ...outcomes }));
  return store;
}

describe('draftsTable', () => {
  it('prints a row per outcome with passed, rejected by, item count and judge score', async () => {
    const store = storeWith({
      drafts: [
        {
          writer: 'w1',
          passed: true,
          rejectedBy: [],
          score: { writer: 'w1', score: 4.25, byCriterion: {} },
        },
        { writer: 'w2', passed: false, rejectedBy: ['linkCheck', 'formatCheck'] },
      ],
    });
    const raw = JSON.stringify({ drafts: [makeDraft([one, two], 'w1'), makeDraft([one], 'w2')] });
    expect(await draftsTable(WEEK, raw, store)).toBe(
      [
        'Writer  Passed  Rejected by             Items  Judge',
        'w1      yes     -                       2      4.3',
        'w2      no      linkCheck, formatCheck  1      -',
        '',
      ].join('\n'),
    );
  });

  it('adds a row for a draft that has no outcome in the record', async () => {
    const store = storeWith({ drafts: [{ writer: 'w1', passed: true, rejectedBy: [] }] });
    const raw = JSON.stringify({
      drafts: [makeDraft([one], 'w1'), makeDraft([one, two], 'extra')],
    });
    const lines = (await draftsTable(WEEK, raw, store)).split('\n');
    expect(lines[1]).toMatch(/^w1 +yes/);
    expect(lines[2]).toMatch(/^extra +- +- +2 +-$/);
  });

  it('lists the writer of an outcome with no draft in the file, with zero items', async () => {
    const store = storeWith({ drafts: [{ writer: 'gone', passed: false, rejectedBy: ['x'] }] });
    const lines = (await draftsTable(WEEK, '{"drafts":[]}', store)).split('\n');
    expect(lines[1]).toMatch(/^gone +no +x +0 +-$/);
  });

  it('prints the drafts file alone when the run has no record', async () => {
    const raw = JSON.stringify({ drafts: [makeDraft([one], 'w1')] });
    const text = await draftsTable(WEEK, raw, new MemoryRunStore());
    expect(text).toBe(
      [
        'Writer  Passed  Rejected by  Items  Judge',
        'w1      -       -            1      -',
        '',
      ].join('\n'),
    );
  });

  it('appends the problems of rejected drafts and failed writers after the table', async () => {
    const raw = JSON.stringify({
      drafts: [makeDraft([one], 'w1')],
      failures: [{ writer: 'w3', error: 'model timed out' }],
      rejections: [
        { writer: 'w2', attempt: 1, rejectedBy: ['linkCheck'], problems: ['dead link'] },
      ],
    });
    const text = await draftsTable(WEEK, raw, storeWith());
    expect(text).toContain('\nProblems:\n  w2: dead link\n  w3: model timed out\n');
    expect(text.indexOf('Writer')).toBeLessThan(text.indexOf('Problems:'));
  });

  it('turns control characters in a writer name into spaces', async () => {
    const raw = JSON.stringify({ drafts: [makeDraft([one], 'evil\u001b[2J')] });
    const text = await draftsTable(WEEK, raw, storeWith());
    expect(text).not.toContain('\u001b');
    expect(text).toContain('evil [2J');
  });

  it('names drafts.json when it is not valid JSON or has the wrong shape', async () => {
    const store = storeWith();
    await expect(draftsTable(WEEK, '{nope', store)).rejects.toThrow(ShowError);
    await expect(draftsTable(WEEK, '{nope', store)).rejects.toThrow(/^drafts\.json is not valid/);
    await expect(draftsTable(WEEK, '{"drafts": 5}', store)).rejects.toThrow(
      'drafts.json does not have the expected shape',
    );
  });
});
