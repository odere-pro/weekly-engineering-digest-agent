import { describe, expect, it } from 'vitest';
import {
  compareWeekIds,
  isoWeekId,
  parseWeekId,
  previousWeekIds,
  weekStartUtc,
} from '../../src/shared/isoWeek.js';

describe('isoWeekId', () => {
  it.each([
    ['2026-10-16T12:00:00Z', '2026-W42'],
    ['2026-10-19T12:00:00Z', '2026-W43'],
    ['2026-01-01T12:00:00Z', '2026-W01'],
    ['2027-01-01T12:00:00Z', '2026-W53'],
    ['2024-12-30T12:00:00Z', '2025-W01'],
  ])('%s is %s', (iso, week) => {
    expect(isoWeekId(new Date(iso))).toBe(week);
  });

  it('uses the given time zone', () => {
    // Sunday 23:30 UTC is already Monday in Berlin.
    const date = new Date('2026-10-18T23:30:00Z');
    expect(isoWeekId(date, 'UTC')).toBe('2026-W42');
    expect(isoWeekId(date, 'Europe/Berlin')).toBe('2026-W43');
  });
});

describe('week helpers', () => {
  it('parses a week id', () => {
    expect(parseWeekId('2026-W43')).toEqual({ year: 2026, week: 43 });
    expect(() => parseWeekId('2026-43')).toThrow('Invalid ISO week id');
  });

  it('finds the Monday of a week', () => {
    expect(weekStartUtc('2026-W43').toISOString()).toBe('2026-10-19T00:00:00.000Z');
    expect(weekStartUtc('2026-W01').toISOString()).toBe('2025-12-29T00:00:00.000Z');
  });

  it('lists previous weeks across a year boundary', () => {
    expect(previousWeekIds('2026-W02', 3)).toEqual(['2026-W01', '2025-W52', '2025-W51']);
  });

  it('compares week ids', () => {
    expect(compareWeekIds('2026-W01', '2025-W52')).toBeGreaterThan(0);
    expect(compareWeekIds('2026-W10', '2026-W10')).toBe(0);
  });
});
