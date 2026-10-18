import { describe, expect, it } from 'vitest';
import { buildFallback, type FallbackInput } from './fallback';
import { FALLBACK_WRITER } from '../write/fallbackDigest';
import type { LogFields } from '../shared/telemetry';
import { makeConfig, makeScoredItem } from '../../test/builders';
import { FakeOutputGuard, noopLogger } from '../../test/fakes';

function input(count = 4, flag = false): { input: FallbackInput; errors: LogFields[] } {
  const selected = Array.from({ length: count }, () => makeScoredItem());
  const errors: LogFields[] = [];
  const logger = {
    ...noopLogger,
    error: (_: string, fields: LogFields = {}) => void errors.push(fields),
  };
  return {
    errors,
    input: {
      selected,
      collected: selected,
      weekId: '2026-W42',
      topN: 5,
      disabledGuards: [],
      outputGuards: [new FakeOutputGuard('graniteGroundedness', () => flag)],
      guardConfig: makeConfig().guards.output,
      drafts: [{ writer: 'w', passed: false, rejectedBy: ['linkCheck'] }],
      logger,
    },
  };
}

describe('buildFallback', () => {
  it('returns a checked digest and a passed outcome when no guard flags it', async () => {
    const result = await buildFallback(input().input);

    expect(result?.winner.draft.writer).toBe(FALLBACK_WRITER);
    expect(result?.outcome).toEqual({ writer: FALLBACK_WRITER, passed: true, rejectedBy: [] });
  });

  it('keeps a guard flag in the outcome and still returns the digest', async () => {
    const result = await buildFallback(input(4, true).input);

    expect(result?.winner.markdown).toContain('Written from');
    expect(result?.outcome).toEqual({
      writer: FALLBACK_WRITER,
      passed: false,
      rejectedBy: ['graniteGroundedness'],
    });
  });

  it('returns nothing and logs an error when its own checks fail (too few items)', async () => {
    const { input: two, errors } = input(2);

    expect(await buildFallback(two)).toBeUndefined();
    expect(errors).toEqual([{ rejectedBy: ['formatCheck'] }]);
  });
});
