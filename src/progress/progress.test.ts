import { describe, expect, it } from 'vitest';
import type { LogFields, Logger } from '../shared/telemetry';
import { steppedClock } from './__fixtures__/steppedClock';
import { formatDuration, PROGRESS_EVERY_ITEMS, PROGRESS_EVERY_MS, startProgress } from './progress';

interface Line {
  level: string;
  message: string;
  fields: LogFields;
}

function recording(): { logger: Logger; lines: Line[] } {
  const lines: Line[] = [];
  const log =
    (level: string) =>
    (message: string, fields: LogFields = {}): void => {
      lines.push({ level, message, fields });
    };
  const logger: Logger = {
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    child: () => logger,
  };
  return { logger, lines };
}

/** Runs `count` items of `ms` each through a tracker of `total` items. */
function run(total: number, count: number, ms: number | readonly number[], label = 'clefPolicy') {
  const { logger, lines } = recording();
  const time = steppedClock();
  const progress = startProgress({ label, total, logger, clock: time.clock });
  for (let index = 0; index < count; index++) {
    time.advance(typeof ms === 'number' ? ms : (ms[index] ?? 0));
    progress.tick();
  }
  return { lines, time };
}

describe('startProgress', () => {
  it('logs every 25 items or every minute, as documented', () => {
    expect(PROGRESS_EVERY_ITEMS).toBe(25);
    expect(PROGRESS_EVERY_MS).toBe(60_000);
  });

  it('says nothing before the first 25 items or the first minute', () => {
    const { lines } = run(147, 24, 2_000);

    expect(lines).toEqual([]);
  });

  it('logs at the 25th item with done, total, the median call and the time left', () => {
    const { lines } = run(100, 25, 2_000);

    expect(lines).toEqual([
      {
        level: 'info',
        message: 'Progress',
        fields: {
          label: 'clefPolicy',
          done: 25,
          total: 100,
          elapsedMs: 50_000,
          medianMs: 2_000,
          etaMs: 150_000,
          eta: '2 min 30 s',
        },
      },
    ]);
  });

  it('logs again every 25 items', () => {
    const { lines } = run(100, 75, 2_000);

    expect(lines.map((line) => line.fields.done)).toEqual([25, 50, 75]);
  });

  it('logs after a minute even when fewer than 25 items are done', () => {
    const { lines } = run(147, 5, 15_000);

    expect(lines.map((line) => line.fields.done)).toEqual([4]);
    expect(lines[0]?.fields).toMatchObject({
      elapsedMs: 60_000,
      medianMs: 15_000,
      etaMs: 2_145_000,
    });
  });

  it('counts the minute from the last line, not from the start', () => {
    const { lines } = run(147, 12, 15_000);

    expect(lines.map((line) => line.fields.done)).toEqual([4, 8, 12]);
  });

  it('estimates from the median, so one slow first call (a model load) does not inflate it', () => {
    const { lines } = run(100, 25, [100_000, ...Array.from({ length: 24 }, () => 10_000)]);

    expect(lines.at(-1)?.fields).toMatchObject({ done: 25, medianMs: 10_000, etaMs: 750_000 });
  });

  it('takes the middle of an even count as the mean of the two middle calls', () => {
    const { lines } = run(10, 4, [1_000, 3_000, 5_000, 70_000]);

    expect(lines).toHaveLength(1);
    expect(lines[0]?.fields).toMatchObject({ done: 4, medianMs: 4_000, etaMs: 24_000 });
  });

  it('logs a last line with nothing left when the final item is done', () => {
    const { lines } = run(10, 10, 2_000);

    expect(lines).toHaveLength(1);
    expect(lines[0]?.fields).toMatchObject({ done: 10, total: 10, etaMs: 0, eta: '0 s' });
  });

  it('logs the final item once, even when it lands on a 25th item', () => {
    const { lines } = run(50, 50, 2_000);

    expect(lines.map((line) => line.fields.done)).toEqual([25, 50]);
  });

  it('ignores ticks past the total', () => {
    const { lines } = run(3, 6, 2_000);

    expect(lines.map((line) => line.fields.done)).toEqual([3]);
  });

  it('logs nothing for an empty pool', () => {
    const { lines } = run(0, 0, 0);

    expect(lines).toEqual([]);
  });

  it('takes the cadence from its options', () => {
    const { logger, lines } = recording();
    const time = steppedClock();
    const progress = startProgress({
      label: 'classify',
      total: 20,
      logger,
      clock: time.clock,
      everyItems: 5,
      everyMs: 1_000_000,
    });

    for (let index = 0; index < 10; index++) {
      time.advance(1_000);
      progress.tick();
    }

    expect(lines.map((line) => line.fields.done)).toEqual([5, 10]);
  });

  it('reads the system clock when none is given', () => {
    const { logger, lines } = recording();
    const progress = startProgress({ label: 'classify', total: 1, logger });

    progress.tick();

    expect(lines[0]?.fields).toMatchObject({ done: 1, total: 1, etaMs: 0 });
  });

  it('puts only counts, times and its label in a line: no item, id or text', () => {
    const { lines } = run(100, 25, 2_000, 'graniteRisk');

    expect(Object.keys(lines[0]?.fields ?? {}).sort()).toEqual(
      ['done', 'elapsedMs', 'eta', 'etaMs', 'label', 'medianMs', 'total'].sort(),
    );
    expect(lines[0]?.fields.label).toBe('graniteRisk');
  });
});

describe('formatDuration', () => {
  it.each([
    [0, '0 s'],
    [400, '0 s'],
    [45_000, '45 s'],
    [59_600, '1 min'],
    [150_000, '2 min 30 s'],
    [1_620_000, '27 min'],
    [3_900_000, '1 h 5 min'],
    [7_200_000, '2 h'],
  ])('%d ms is %s', (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});
