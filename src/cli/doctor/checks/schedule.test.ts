import { describe, expect, it } from 'vitest';
import { makeConfig } from '../../../../test/builders';
import { fixedClock } from '../../../../test/fakes';
import { resultFor, runDoctor } from '../__fixtures__/doctorHarness';
import { checkSchedule } from './schedule';

/** A Friday: the next Monday 07:45 in Berlin (CEST) is 05:45 UTC on the 19th. */
const NOW = '2026-10-16T09:00:00Z';
const clock = fixedClock(NOW);

function scheduleOf(cron: string, timeZone: string) {
  return makeConfig({ schedule: { cron, timeZone } }).schedule;
}

describe('checkSchedule', () => {
  it('is ok and names the next run as an ISO time', () => {
    const result = checkSchedule(scheduleOf('45 7 * * 1', 'Europe/Berlin'), clock);

    expect(result).toEqual({
      severity: 'ok',
      label: 'schedule',
      message: 'next run 2026-10-19T05:45:00.000Z (cron "45 7 * * 1", Europe/Berlin)',
    });
  });

  it('reads the time zone, so the same cron fires at another instant elsewhere', () => {
    const result = checkSchedule(scheduleOf('45 7 * * 1', 'America/New_York'), clock);

    expect(result.message).toContain('next run 2026-10-19T11:45:00.000Z');
  });

  it('is an error that names the cron and the zone when the cron has too few fields', () => {
    const result = checkSchedule(scheduleOf('* * *', 'Europe/Berlin'), clock);

    expect(result.severity).toBe('error');
    expect(result.label).toBe('schedule');
    expect(result.message).toContain('Invalid schedule (cron "* * *", time zone "Europe/Berlin"):');
    expect(result.message).toContain('CronPattern');
    expect(result.fix).toContain('schedule.cron');
    expect(result.fix).toContain('45 7 * * 1');
  });

  it('is an error that names the zone when the time zone is not an IANA name', () => {
    const result = checkSchedule(scheduleOf('45 7 * * 1', 'Mars/Olympus'), clock);

    expect(result.severity).toBe('error');
    expect(result.message).toContain(
      'Invalid schedule (cron "45 7 * * 1", time zone "Mars/Olympus"):',
    );
    expect(result.fix).toContain('schedule.timeZone');
    expect(result.fix).toContain('Europe/Berlin');
  });

  it('warns when the cron is valid but never fires: serve starts and then sits idle', () => {
    const result = checkSchedule(scheduleOf('0 0 31 2 *', 'UTC'), clock);

    expect(result.severity).toBe('warn');
    expect(result.message).toBe('cron "0 0 31 2 *" never fires (no date matches it)');
    expect(result.fix).toContain('schedule.cron');
  });
});

describe('doctorCommand schedule line', () => {
  it('prints a ✓ with the next run for the default schedule', async () => {
    const { text, code } = await runDoctor();

    expect(code).toBe(0);
    expect(resultFor(text, '✓', 'schedule:')).toContain('next run 2026-10-19T05:45:00.000Z');
  });

  it('prints a ✗ with a fix and exits 1 for a cron serve would refuse', async () => {
    const { text, code } = await runDoctor({
      config: { schedule: { cron: '* * *', timeZone: 'Europe/Berlin' } },
    });

    expect(code).toBe(1);
    expect(resultFor(text, '✗', 'schedule:')).toMatch(
      /Invalid schedule \(cron "\* \* \*"[^\n]*\n\s+fix: /,
    );
  });

  it('prints a ✗ for a time zone serve would refuse', async () => {
    const { text, code } = await runDoctor({
      config: { schedule: { cron: '45 7 * * 1', timeZone: 'Mars/Olympus' } },
    });

    expect(code).toBe(1);
    expect(resultFor(text, '✗', 'schedule:')).toContain('time zone "Mars/Olympus"');
  });
});
