import { describe, expect, it } from 'vitest';
import { guardRealBlocks, noDigestCause, type ReplayEnd } from './guardRealBlocks';
import type { GuardCheckId } from '../../../src/guards/guardVerdict';

const draftOutcome = (rejectedBy: string[]) => ({ writer: 'gemma', passed: false, rejectedBy });

const blockedEnd = (label: string, rejectedBy: string[][], reason?: string): ReplayEnd => ({
  label,
  status: 'blocked',
  drafts: rejectedBy.map(draftOutcome),
  outputVerdicts: rejectedBy.flatMap((ids) =>
    ids
      .filter((id) => id.startsWith('granite') || id.startsWith('clef'))
      .map((id) => ({
        check: id as GuardCheckId,
        flagged: true,
        ...(reason === undefined ? {} : { reason }),
      })),
  ),
});

const okEnd = (label: string): ReplayEnd => ({
  label,
  status: 'dry-run',
  drafts: [{ writer: 'gemma', passed: true, rejectedBy: [] }],
  outputVerdicts: [],
});

describe('guardRealBlocks', () => {
  it('counts a replay where an output guard rejected every draft, with its reason', () => {
    const measurement = guardRealBlocks([
      okEnd('2026-W36'),
      blockedEnd('2026-W36', [['graniteGroundedness']], 'claim not in source'),
      okEnd('2026-W36'),
    ]);

    expect(measurement.value).toBeCloseTo(1 / 3);
    expect(measurement.detail).toMatchObject({
      runs: 3,
      blockedRuns: 1,
      graniteGroundedness: 1 / 3,
      clefRubric: 0,
    });
    expect(measurement.byWeek?.['2026-W36 (2)']).toEqual({
      status: 'failed',
      problems: ['blocked by graniteGroundedness: claim not in source'],
      problemCount: 1,
    });
    expect(measurement.byWeek?.['2026-W36']?.status).toBe('ok');
  });

  it('does not count a run rejected by the link check as a guard block', () => {
    const measurement = guardRealBlocks([blockedEnd('2026-W37', [['linkCheck']]), okEnd('x')]);

    expect(measurement.value).toBe(0);
    expect(measurement.byWeek?.['2026-W37']?.status).toBe('ok');
  });

  it('counts a draft rejected by a guard and the link check together', () => {
    const measurement = guardRealBlocks([blockedEnd('w', [['linkCheck', 'clefRubric']], 'bad')]);
    expect(measurement.value).toBe(1);
  });

  it('is not a guard block when one draft was rejected by a check only', () => {
    const measurement = guardRealBlocks([
      blockedEnd('w', [['graniteGroundedness'], ['linkCheck']]),
    ]);
    expect(measurement.value).toBe(0);
  });

  it('cuts a long reason short and handles a missing one', () => {
    const long = guardRealBlocks([blockedEnd('w', [['clefRubric']], 'x'.repeat(500))]);
    expect(long.byWeek?.w?.problems[0]?.length).toBeLessThan(260);
    const none = guardRealBlocks([blockedEnd('w', [['clefRubric']])]);
    expect(none.byWeek?.w?.problems).toEqual(['blocked by clefRubric']);
  });

  it('is null without replays', () => {
    expect(guardRealBlocks([]).value).toBeNull();
  });
});

describe('noDigestCause', () => {
  it('names the guard that blocked the run', () => {
    expect(noDigestCause(blockedEnd('w', [['graniteGroundedness']]))).toBe(
      'blocked by graniteGroundedness',
    );
  });
  it('names the check that rejected the run', () => {
    expect(noDigestCause(blockedEnd('w', [['linkCheck']]))).toBe('rejected by linkCheck');
  });
  it('names both when both rejected', () => {
    expect(noDigestCause(blockedEnd('w', [['clefRubric'], ['formatCheck']]))).toBe(
      'blocked by clefRubric; rejected by formatCheck',
    );
  });
  it('falls back to the run status', () => {
    expect(noDigestCause({ ...okEnd('w'), status: 'quiet', drafts: [] })).toBe(
      'run ended as "quiet"',
    );
    expect(noDigestCause({ ...okEnd('w'), status: 'blocked', drafts: [] })).toBe(
      'run ended as "blocked"',
    );
  });
});
