import { describe, expect, it } from 'vitest';
import { makeItem } from '../../../../test/builders';
import { makeFailedReport, makeReport } from '../__fixtures__/makeReport';
import { formatTotals, totalsOf } from './totals';

describe('totalsOf', () => {
  it('counts sources, how many worked and failed, and all items', () => {
    const totals = totalsOf([
      makeReport(),
      makeFailedReport('oops'),
      makeReport({ items: [makeItem(), makeItem(), makeItem()] }),
    ]);

    expect(totals).toEqual({ sources: 3, ok: 2, failed: 1, items: 5 });
  });

  it('is all zeros for no reports', () => {
    expect(totalsOf([])).toEqual({ sources: 0, ok: 0, failed: 0, items: 0 });
  });
});

describe('formatTotals', () => {
  it('says the counts in one line', () => {
    const line = formatTotals([makeReport(), makeFailedReport('oops')]);

    expect(line).toBe('2 sources: 1 ok, 1 failed, 2 items');
  });

  it('uses the singular for exactly one source and one item', () => {
    const line = formatTotals([makeReport({ items: [makeItem()] })]);

    expect(line).toBe('1 source: 1 ok, 0 failed, 1 item');
  });

  it('uses the plural for zero', () => {
    expect(formatTotals([])).toBe('0 sources: 0 ok, 0 failed, 0 items');
  });
});
