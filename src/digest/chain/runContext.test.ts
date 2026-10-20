import { describe, expect, it } from 'vitest';
import { holdingLock, runContext } from './runContext';
import { DigestError, errorMessage } from '../../shared/errors';
import { LOCK_LOST_MESSAGE, lockLostReason } from '../../store/lockLost';
import { FakeInputGuard, FakeOutputGuard } from '../../../test/fakes';
import { NOW, WEEK, contextFor } from '../__fixtures__/stageKit';

describe('runContext', () => {
  it('takes the week from the clock in the configured time zone and the window from the config', () => {
    const { deps } = contextFor();

    const ctx = runContext(deps, {});

    expect(ctx).toMatchObject({
      weekId: WEEK,
      sinceDays: deps.config.windowDays,
      startedAt: new Date(NOW),
    });
  });

  it('starts with the defaults: a real run that notifies, with the fallback and no held files', () => {
    const ctx = runContext(contextFor().deps, {});

    expect(ctx).toMatchObject({
      dryRun: false,
      notifyFailure: true,
      useFallback: true,
      holdArtifacts: false,
    });
    expect(ctx.signal).toBeUndefined();
  });

  it('takes what the options say', () => {
    const signal = new AbortController().signal;

    const ctx = runContext(contextFor().deps, {
      weekId: '2026-W40',
      sinceDays: 3,
      dryRun: true,
      notifyFailure: false,
      noFallback: true,
      signal,
    });

    expect(ctx).toMatchObject({
      weekId: '2026-W40',
      sinceDays: 3,
      dryRun: true,
      notifyFailure: false,
      useFallback: false,
      signal,
    });
  });

  it('binds the logger to the run id', () => {
    const h = contextFor();

    runContext(h.deps, {}).logger.info('hello');

    expect(h.logs.at(-1)).toMatchObject({ message: 'hello', fields: { runId: WEEK } });
  });

  it.each(['2026-43', 'W43', '2026-W4', '', '2026-W43 '])('refuses the week id "%s"', (weekId) => {
    expect(() => runContext(contextFor().deps, { weekId })).toThrow(DigestError);
  });

  it.each([0, -1, 1.5, Number.NaN])('refuses the window of %s days', (sinceDays) => {
    expect(() => runContext(contextFor().deps, { sinceDays })).toThrow(
      /whole number of days, at least 1/,
    );
  });

  it('lists the checks that are off this run, input checks before output checks', () => {
    const h = contextFor({
      inputGuards: [new FakeInputGuard('ruleInjection'), new FakeInputGuard('clefPolicy')],
      outputGuards: [new FakeOutputGuard('graniteGroundedness')],
    });

    const ctx = runContext(h.deps, {});

    expect(ctx.disabledGuards).toEqual(['graniteRisk', 'clefRubric']);
  });

  it('names a missing guard without logging a warning: the guard steps log those', () => {
    const h = contextFor({ inputGuards: [], outputGuards: [] });

    const ctx = runContext(h.deps, {});

    expect(ctx.disabledGuards).toHaveLength(5);
    expect(h.logs.filter((line) => line.level === 'warn')).toEqual([]);
  });
});

describe('holdingLock', () => {
  it('fires the run signal, with the lock reason, once the lock is lost', () => {
    const lock = new AbortController();
    const ctx = holdingLock(runContext(contextFor().deps, {}), lock.signal);
    expect(ctx.signal?.aborted).toBe(false);

    lock.abort(lockLostReason());

    expect(ctx.signal?.aborted).toBe(true);
    expect(errorMessage(ctx.signal?.reason)).toBe(LOCK_LOST_MESSAGE);
    expect(ctx.lockLost).toBe(lock.signal);
  });

  it("still fires the run signal for the caller's stop, which is not a lost lock", () => {
    const caller = new AbortController();
    const lock = new AbortController();
    const ctx = holdingLock(runContext(contextFor().deps, { signal: caller.signal }), lock.signal);

    caller.abort(new Error('run timed out after 3 h'));

    expect(errorMessage(ctx.signal?.reason)).toBe('run timed out after 3 h');
    expect(ctx.lockLost?.aborted).toBe(false);
  });
});
