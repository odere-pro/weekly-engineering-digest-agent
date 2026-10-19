import { describe, expect, it, vi, type Mock } from 'vitest';
import { weekStartUtc } from '../../shared/isoWeek';
import { firstSlotOfWeek, MAX_UTC_OFFSET_MS, type SlotSource } from './firstSlotOfWeek';

/** A cron that fires at the given times: `nextRun` is the first one strictly after `from`. */
function firesAt(...times: string[]): { nextRun: Mock<SlotSource['nextRun']> } {
  const slots = times.map((time) => new Date(time));
  const nextRun = vi.fn((from?: Date): Date | null => {
    const after = from?.getTime() ?? Number.NEGATIVE_INFINITY;
    return slots.find((slot) => slot.getTime() > after) ?? null;
  });
  return { nextRun };
}

describe('firstSlotOfWeek', () => {
  it('finds the first fire inside the local ISO week', () => {
    const job = firesAt('2026-10-12T05:45:00Z', '2026-10-19T05:45:00Z');

    const slot = firstSlotOfWeek(job, '2026-W42', 'Europe/Berlin');

    expect(slot?.toISOString()).toBe('2026-10-12T05:45:00.000Z');
  });

  it('skips fires that belong to an earlier week', () => {
    const job = firesAt('2026-10-11T21:00:00Z', '2026-10-12T05:45:00Z');

    const slot = firstSlotOfWeek(job, '2026-W42', 'Europe/Berlin');

    // 21:00Z on Sunday is still Sunday evening of week 41 in Berlin (23:00 CEST).
    expect(slot?.toISOString()).toBe('2026-10-12T05:45:00.000Z');
  });

  it('keeps a fire at exactly local Monday midnight in the furthest zone ahead (UTC+14)', () => {
    // Pacific/Kiritimati is UTC+14: Monday 00:00 there is Sunday 10:00 UTC.
    const job = firesAt('2026-10-11T10:00:00Z', '2026-10-18T10:00:00Z');

    const slot = firstSlotOfWeek(job, '2026-W42', 'Pacific/Kiritimati');

    expect(slot?.toISOString()).toBe('2026-10-11T10:00:00.000Z');
  });

  it('starts one millisecond before the earliest local Monday, so that midnight stays in reach', () => {
    const job = firesAt('2026-10-12T05:45:00Z');

    firstSlotOfWeek(job, '2026-W42', 'Europe/Berlin');

    const expectedFrom = weekStartUtc('2026-W42').getTime() - MAX_UTC_OFFSET_MS - 1;
    expect(job.nextRun).toHaveBeenNthCalledWith(1, new Date(expectedFrom));
  });

  it('reaches back 14 hours, the largest offset a time zone has', () => {
    expect(MAX_UTC_OFFSET_MS).toBe(14 * 3_600_000);
  });

  it('returns a fire in a later week as it is: the cron skips this week', () => {
    const job = firesAt('2026-10-19T05:45:00Z');

    const slot = firstSlotOfWeek(job, '2026-W42', 'Europe/Berlin');

    expect(slot?.toISOString()).toBe('2026-10-19T05:45:00.000Z');
  });

  it('returns null when the cron never fires again', () => {
    expect(firstSlotOfWeek(firesAt(), '2026-W42', 'Europe/Berlin')).toBeNull();
  });

  it('returns null when the only fire left is in an earlier week', () => {
    // Sunday 23:00 in Berlin: week 41, found by the early start and then passed over.
    const job = firesAt('2026-10-11T21:00:00Z');

    expect(firstSlotOfWeek(job, '2026-W42', 'Europe/Berlin')).toBeNull();
  });
});
