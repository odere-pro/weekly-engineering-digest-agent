import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  dayOf,
  isReservedSourceId,
  logsDir,
  sourceDir,
  weekAnswersFile,
  weekDay,
  weekDigestDir,
  weekOfDay,
} from './layout';

describe('dayOf', () => {
  it('formats the calendar day as YYYY-MM-DD in UTC by default', () => {
    expect(dayOf(new Date('2026-10-19T23:30:00Z'))).toBe('2026-10-19');
  });

  it('uses the given time zone, so a late UTC evening is the next day in Berlin', () => {
    expect(dayOf(new Date('2026-10-19T23:30:00Z'), 'Europe/Berlin')).toBe('2026-10-20');
  });
});

describe('weekDay', () => {
  it('names a week by its Monday', () => {
    expect(weekDay('2026-W43')).toBe('2026-10-19');
  });

  it('handles a week whose Monday is in the previous year', () => {
    expect(weekDay('2026-W01')).toBe('2025-12-29');
  });

  it('refuses a week 53 that its year does not have, instead of naming the next week 1', () => {
    expect(weekDay('2026-W53')).toBe('2026-12-28');
    expect(() => weekDay('2025-W53')).toThrow(/Invalid run id/);
  });

  it('refuses anything but an ISO week id, so no path can leave the data folder', () => {
    expect(() => weekDay('../2026-W43')).toThrow(/Invalid run id/);
  });
});

describe('weekOfDay', () => {
  it('maps a Monday folder back to its week', () => {
    expect(weekOfDay('2026-10-19')).toBe('2026-W43');
  });

  it('is undefined for a day that is not a Monday (a `digest fetch` folder)', () => {
    expect(weekOfDay('2026-10-21')).toBeUndefined();
  });

  it('is undefined for names that are not days', () => {
    expect(weekOfDay('logs')).toBeUndefined();
    expect(weekOfDay('artifacts')).toBeUndefined();
    expect(weekOfDay('2026-13-01')).toBeUndefined();
    expect(weekOfDay('2026-02-30')).toBeUndefined();
  });
});

describe('folders', () => {
  it('puts a week run in <dataDir>/<monday>/digest', () => {
    expect(weekDigestDir('dist', '2026-W43')).toBe(join('dist', '2026-10-19', 'digest'));
  });

  it('puts the week answer cache next to its run files, where prune clears it', () => {
    expect(weekAnswersFile('dist', '2026-W43')).toBe(
      join('dist', '2026-10-19', 'digest', 'answers.jsonl'),
    );
    expect(() => weekAnswersFile('dist', '../2026-W43')).toThrow(/Invalid run id/);
  });

  it('puts a source raw and formatted data in <dataDir>/<day>/<sourceId>/<part>', () => {
    expect(sourceDir('dist', '2026-10-19', 'openai-news', 'raw')).toBe(
      join('dist', '2026-10-19', 'openai-news', 'raw'),
    );
    expect(sourceDir('dist', '2026-10-19', 'openai-news', 'formatted')).toBe(
      join('dist', '2026-10-19', 'openai-news', 'formatted'),
    );
  });

  it('refuses a source id that is not a plain folder name', () => {
    expect(() => sourceDir('dist', '2026-10-19', '../etc', 'raw')).toThrow(/source id/);
    expect(() => sourceDir('dist', '2026-10-19', 'digest', 'raw')).toThrow(/reserved/);
  });

  it('refuses a day that is not YYYY-MM-DD', () => {
    expect(() => sourceDir('dist', '..', 'openai-news', 'raw')).toThrow(/day/);
    expect(() => logsDir('dist', '2026-10')).toThrow(/day/);
  });

  it('puts the logs of a day in <dataDir>/logs/<day>', () => {
    expect(logsDir('dist', '2026-10-19')).toBe(join('dist', 'logs', '2026-10-19'));
  });
});

describe('isReservedSourceId', () => {
  it('reserves the digest folder name only', () => {
    expect(isReservedSourceId('digest')).toBe(true);
    expect(isReservedSourceId('openai-news')).toBe(false);
  });
});
