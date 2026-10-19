import { describe, expect, it } from 'vitest';
import { caseEntries, measured, withByWeek } from './measurement';
import type { WeekDetail } from '../../schema';

describe('measured', () => {
  it('is only the value when there is no detail', () => {
    expect(measured(0.5)).toEqual({ value: 0.5 });
    expect(measured(null, {})).toEqual({ value: null });
  });

  it('carries the detail when it has entries', () => {
    expect(measured(1, { a: 2 })).toEqual({ value: 1, detail: { a: 2 } });
  });
});

describe('withByWeek', () => {
  const ok: WeekDetail = { status: 'ok', problems: [], problemCount: 0 };

  it('is only the value without weeks', () => {
    expect(withByWeek(null, [])).toEqual({ value: null });
  });

  it('keys the weeks by label', () => {
    const result = withByWeek(1, [
      { label: '2026-W40', detail: ok },
      { label: '2026-W41', detail: { ...ok, status: 'failed' } },
    ]);

    expect(result.value).toBe(1);
    expect(Object.keys(result.byWeek ?? {})).toEqual(['2026-W40', '2026-W41']);
    expect(result.byWeek?.['2026-W41']?.status).toBe('failed');
  });
});

describe('caseEntries', () => {
  it('names each case under its kind with the value 1', () => {
    expect(caseEntries('unchecked', ['a1', 'a2'])).toEqual([
      ['unchecked:a1', 1],
      ['unchecked:a2', 1],
    ]);
  });

  it('is empty without cases', () => {
    expect(caseEntries('unchecked', [])).toEqual([]);
  });
});
