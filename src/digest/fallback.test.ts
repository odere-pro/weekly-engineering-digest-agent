import { describe, expect, it } from 'vitest';
import { buildFallback, type FallbackInput } from './fallback';
import { FALLBACK_WRITER } from '../write/fallbackDigest';
import type { LogFields } from '../shared/telemetry';
import type { Draft, Item } from '../domain/schemas';
import type { GuardCallOptions, OutputGuard } from '../guards/Guard';
import type { GuardVerdict } from '../guards/guardVerdict';
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

describe('buildFallback when the run is told to stop', () => {
  class SignalGuard implements OutputGuard {
    readonly options: (GuardCallOptions | undefined)[] = [];
    readonly id = 'graniteGroundedness' as const;
    checkDraft(
      _draft: Draft,
      _sources: readonly Item[],
      options?: GuardCallOptions,
    ): Promise<GuardVerdict> {
      this.options.push(options);
      return Promise.resolve({ check: this.id, flagged: false });
    }
  }

  it('hands the signal to the output guard that checks the digest', async () => {
    const controller = new AbortController();
    const guard = new SignalGuard();

    await buildFallback({ ...input().input, outputGuards: [guard], signal: controller.signal });

    expect(guard.options).toHaveLength(1);
    expect(guard.options[0]?.signal).toBe(controller.signal);
  });

  it('rejects with the reason, and starts no guard call, when the signal fired already', async () => {
    const controller = new AbortController();
    const reason = new Error('run timed out');
    controller.abort(reason);
    const guard = new SignalGuard();

    await expect(
      buildFallback({ ...input().input, outputGuards: [guard], signal: controller.signal }),
    ).rejects.toBe(reason);

    expect(guard.options).toEqual([]);
  });
});
