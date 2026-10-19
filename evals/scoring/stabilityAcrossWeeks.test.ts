import { describe, expect, it } from 'vitest';
import { makeRunRecord } from '../../test/builders';
import { stability } from '../metrics/run/stability';
import { makeReplay } from '../replay/__fixtures__/replayKit';
import { stabilityAcrossWeeks } from './stabilityAcrossWeeks';
import type { StabilityWeek } from './types';

const week = (weekId: string, runs: string[][], cause?: ReturnType<typeof makeRunRecord>) => ({
  weekId,
  runs,
  replays: runs.map(() => makeReplay({ weekId, ...(cause ? { record: cause } : {}) })),
});

describe('stabilityAcrossWeeks', () => {
  it('is not measured when no week was replayed', () => {
    expect(stabilityAcrossWeeks([])).toEqual(stability([]));
    expect(stabilityAcrossWeeks([]).value).toBeNull();
  });

  it('is the plain measurement of the week when only one week was replayed', () => {
    const runs = [
      ['a', 'b', 'c'],
      ['a', 'b', 'd'],
      ['a', 'b', 'c'],
    ];

    const result = stabilityAcrossWeeks([week('2026-W40', runs)]);

    expect(result).toEqual(stability(runs, '2026-W40'));
    expect(result.byWeek).toBeUndefined();
  });

  describe('with several weeks', () => {
    const w40 = week('2026-W40', [
      ['a', 'b'],
      ['a', 'b'],
      ['a', 'b'],
    ]);
    const w41 = week('2026-W41', [
      ['a', 'b', 'c'],
      ['a', 'b', 'c'],
      ['a', 'x', 'y'],
    ]);

    it("keeps the first week's value, note, detail and runs as the gate", () => {
      const result = stabilityAcrossWeeks([w40, w41]);

      expect(result.value).toBe(2);
      expect(result.note).toBe('overlap of 3 runs of 2026-W40');
      expect(result.detail).toEqual({ runs: 3, emptyRuns: 0 });
      expect(result.itemIdsByRun).toEqual(w40.runs);
    });

    it('adds the overlap of each week under byWeek', () => {
      const { byWeek } = stabilityAcrossWeeks([w40, w41]);

      expect(byWeek?.['2026-W40']).toEqual({
        status: 'ok',
        problems: ['overlap 2.00 items over 3 runs, 0 empty'],
        problemCount: 0,
      });
      // Pairs: (abc, abc) 3, (abc, axy) 1, (abc, axy) 1 -> mean 5/3.
      expect(byWeek?.['2026-W41']?.problems[0]).toBe('overlap 1.67 items over 3 runs, 0 empty');
    });

    it('lists a week with an empty run as no-digest and gives the cause of each empty run', () => {
      const blocked = makeRunRecord({
        status: 'blocked',
        drafts: [{ writer: 'gemma', passed: false, rejectedBy: ['linkCheck'] }],
      });
      const empty: StabilityWeek = week('2026-W41', [['a', 'b'], [], ['a', 'b']], blocked);

      const { byWeek } = stabilityAcrossWeeks([w40, empty]);

      expect(byWeek?.['2026-W41']).toMatchObject({ status: 'no-digest', problemCount: 1 });
      expect(byWeek?.['2026-W41']?.problems).toEqual([
        'overlap 0.67 items over 3 runs, 1 empty',
        'run 2: rejected by linkCheck',
      ]);
      expect(byWeek?.['2026-W40']?.status).toBe('ok');
    });

    it('treats a first week with an empty run as the gate too: the value counts the empty run', () => {
      const first = week('2026-W40', [[], ['a'], ['a']]);

      const result = stabilityAcrossWeeks([first, w41]);

      expect(result.detail).toEqual({ runs: 3, emptyRuns: 1 });
      expect(result.byWeek?.['2026-W40']?.status).toBe('no-digest');
    });
  });
});
