import { describe, expect, it } from 'vitest';
import type { WeekRecord } from '../types';
import { feedA, itemAt, itemsOnDay, repoB } from '../__fixtures__/recordKit';
import { failedLines, reportLines, sourceLines } from './reportLines';

const quiet = { sources: [feedA, repoB], origin: 'config' } as const;

const records: WeekRecord[] = [
  { weekId: '2021-W01', items: itemsOnDay('2021-01-05', 12) },
  {
    weekId: '2021-W02',
    items: [
      ...itemsOnDay('2021-01-12', 10),
      itemAt('2021-01-13T10:00:00Z', { sourceId: 'repo-b', kind: 'github' }),
    ],
    alreadyRecorded: 8,
  },
];

describe('reportLines', () => {
  it('opens with the weeks recorded and the folder, then the sources used', () => {
    const lines = reportLines('/data/weeks', records, quiet, []);

    expect(lines.slice(0, 3)).toEqual([
      'Recorded 2 weeks (2021-W01 to 2021-W02) in /data/weeks',
      'Sources: 2 (digest.config.json)',
      'Items per week:',
    ]);
  });

  it('names the default allowlist when no config file was used', () => {
    const lines = reportLines('/data/weeks', records, { ...quiet, origin: 'default' }, []);

    expect(lines[1]).toBe('Sources: 2 (default allowlist)');
  });

  it('lists one line per week, then one per source, in that order', () => {
    const lines = reportLines('/data/weeks', records, quiet, []);

    expect(lines.slice(3)).toEqual([
      '  2021-W01  12 items',
      '  2021-W02  11 items  8 already recorded, 3 added',
      'Items per source, all recorded weeks:',
      '  feed-a  22',
      '  repo-b  1',
    ]);
  });

  it('adds the failed sources and the way to fill them in at the end', () => {
    const lines = reportLines('/data/weeks', records, quiet, [
      { sourceId: 'feed-a', error: 'connect ECONNREFUSED' },
    ]);

    expect(lines.slice(-2)).toEqual([
      'WARNING: 1 failed sources: feed-a (connect ECONNREFUSED)',
      'Their items are missing, so some weeks are incomplete. Run pnpm eval:record again to fill them in; recorded items are kept.',
    ]);
  });
});

describe('sourceLines', () => {
  it('counts the items of each source over all weeks and aligns the counts', () => {
    expect(sourceLines([feedA, repoB], records)).toEqual(['  feed-a  22', '  repo-b  1']);
  });

  it('pads every source id to the longest one', () => {
    const sources = [feedA, { ...repoB, id: 'a-much-longer-repo-id' }];

    expect(sourceLines(sources, [records[0]!])).toEqual([
      '  feed-a                 12',
      '  a-much-longer-repo-id  0',
    ]);
  });

  it('shows a source with no items as 0', () => {
    expect(sourceLines([feedA, repoB], [{ weekId: '2021-W01', items: [] }])).toEqual([
      '  feed-a  0',
      '  repo-b  0',
    ]);
  });

  it('also counts a source that is no longer in the list, after the listed ones', () => {
    const retired = itemAt('2021-01-12T10:00:00Z', { sourceId: 'retired-feed' });

    expect(sourceLines([feedA], [{ weekId: '2021-W02', items: [retired] }])).toEqual([
      '  feed-a        0',
      '  retired-feed  1',
    ]);
  });
});

describe('failedLines', () => {
  it('is empty when no source failed', () => {
    expect(failedLines([])).toEqual([]);
  });

  it('lists every failed source with its error, in one warning line', () => {
    const lines = failedLines([
      { sourceId: 'feed-a', error: 'timeout' },
      { sourceId: 'repo-b', error: 'HTTP 500' },
    ]);

    expect(lines[0]).toBe('WARNING: 2 failed sources: feed-a (timeout); repo-b (HTTP 500)');
    expect(lines).toHaveLength(2);
  });
});
