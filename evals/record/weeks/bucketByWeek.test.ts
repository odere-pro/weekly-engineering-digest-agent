import { describe, expect, it } from 'vitest';
import { itemAt } from '../__fixtures__/recordKit';
import { bucketByWeek } from './bucketByWeek';

describe('bucketByWeek', () => {
  it('assigns items to ISO weeks across a year boundary', () => {
    const sunday = itemAt('2020-12-27T23:59:59Z');
    const mondayW53 = itemAt('2020-12-28T00:00:00Z');
    const sundayW53 = itemAt('2021-01-03T23:59:59Z');
    const mondayW01 = itemAt('2021-01-04T00:00:00Z');

    const buckets = bucketByWeek(
      [sunday, mondayW53, sundayW53, mondayW01],
      ['2020-W52', '2020-W53', '2021-W01'],
    );

    expect(buckets.get('2020-W52')).toEqual([sunday]);
    expect(buckets.get('2020-W53')).toEqual([mondayW53, sundayW53]);
    expect(buckets.get('2021-W01')).toEqual([mondayW01]);
  });

  it('puts the last days of a calendar year into week 01 of the next ISO year', () => {
    const item = itemAt('2024-12-30T08:00:00Z');

    const buckets = bucketByWeek([item], ['2024-W52', '2025-W01']);

    expect(buckets.get('2025-W01')).toEqual([item]);
    expect(buckets.get('2024-W52')).toEqual([]);
  });

  it('keeps every requested week, drops other weeks and keeps the input order', () => {
    const later = itemAt('2021-01-06T10:00:00Z');
    const earlier = itemAt('2021-01-05T10:00:00Z');
    const outside = itemAt('2021-02-01T10:00:00Z');

    const buckets = bucketByWeek([later, outside, earlier], ['2021-W01', '2021-W02']);

    expect([...buckets.keys()]).toEqual(['2021-W01', '2021-W02']);
    expect(buckets.get('2021-W01')).toEqual([later, earlier]);
    expect(buckets.get('2021-W02')).toEqual([]);
  });

  it('gives an empty bucket per week when there are no items', () => {
    const buckets = bucketByWeek([], ['2021-W01']);

    expect([...buckets]).toEqual([['2021-W01', []]]);
  });

  it('counts the week in UTC, whatever the local time zone', () => {
    const sundayNight = itemAt('2021-01-10T23:30:00-05:00'); // Monday 04:30 UTC, in W02

    const buckets = bucketByWeek([sundayNight], ['2021-W01', '2021-W02']);

    expect(buckets.get('2021-W02')).toEqual([sundayNight]);
    expect(buckets.get('2021-W01')).toEqual([]);
  });
});
