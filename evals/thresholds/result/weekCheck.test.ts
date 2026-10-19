import { describe, expect, it } from 'vitest';
import { DEFAULTS, SEPARABLE } from '../__fixtures__/records';
import type { WeekItemRecord } from '../capture/schemas';
import { weekCheck } from './weekCheck';

const week = (
  itemId: string,
  label: WeekItemRecord['label'],
  result: WeekItemRecord['result'],
): WeekItemRecord => ({ itemId, weekId: '2026-W40', label, result });

const KEPT = SEPARABLE[0]!.result;
const DROPPED = SEPARABLE[3]!.result;

describe('weekCheck', () => {
  it('counts the items the thresholds keep and how the labelled ones fare', () => {
    const records = [
      week('a', 'mustInclude', KEPT),
      week('b', 'mustInclude', DROPPED),
      week('c', 'mustExclude', DROPPED),
      week('d', 'mustExclude', KEPT),
      week('e', null, KEPT),
    ];
    expect(weekCheck(records, DEFAULTS)).toEqual({
      items: 5,
      kept: 3,
      mustInclude: 2,
      mustIncludeKept: 1,
      mustExclude: 2,
      mustExcludeDropped: 1,
    });
  });

  it('leaves out items whose classification failed', () => {
    const records = [week('a', 'mustInclude', { error: 'timeout' }), week('b', null, KEPT)];
    expect(weekCheck(records, DEFAULTS)).toMatchObject({ items: 1, mustInclude: 0 });
  });

  it('is all zeros for a week without records', () => {
    expect(weekCheck([], DEFAULTS)).toEqual({
      items: 0,
      kept: 0,
      mustInclude: 0,
      mustIncludeKept: 0,
      mustExclude: 0,
      mustExcludeDropped: 0,
    });
  });
});
