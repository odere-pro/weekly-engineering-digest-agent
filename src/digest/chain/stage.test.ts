import { describe, expect, it, vi } from 'vitest';
import { PartialFailure, StepFailure } from './failures';
import type { RunContext } from './runContext';
import { stage, type StageFn } from './stage';
import { DigestError } from '../../shared/errors';
import { isUnretriable } from '../ending/notes/unretriable';
import type { Clock } from '../../shared/clock';
import { WEEK, contextFor, stateOf } from '../__fixtures__/stageKit';

/** A clock that answers with each instant in turn, then the last one again. */
function steppingClock(...instants: string[]): Clock {
  let index = 0;
  return {
    now: () => new Date(instants[Math.min(index++, instants.length - 1)] ?? instants[0]!),
  };
}

function withClock(ctx: RunContext, clock: Clock): RunContext {
  return { ...ctx, deps: { ...ctx.deps, clock } };
}

const ok: StageFn = (_ctx, state) => Promise.resolve(state);

describe('stage', () => {
  it('is a workflow step named after the pipeline step', () => {
    expect(stage(contextFor().ctx, 'classify', ok).id).toBe('classify');
  });

  it('runs the stage with the context, the state and a logger bound to the step', async () => {
    const h = contextFor();
    const fn = vi.fn<StageFn>((_ctx, state, logger) => {
      logger.info('inside');
      return Promise.resolve(state);
    });
    const state = stateOf();

    await stage(h.ctx, 'guardInput', fn).run(state);

    expect(fn).toHaveBeenCalledWith(h.ctx, state, expect.anything());
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        message: 'inside',
        fields: { runId: WEEK, step: 'guardInput' },
      }),
    );
  });

  it('traces the stage as a span named after the step', async () => {
    const h = contextFor();

    await stage(h.ctx, 'write', ok).run(stateOf());

    expect(h.spans).toEqual(['write']);
  });

  it('adds the time the stage took to the state and logs it', async () => {
    const h = contextFor();
    const ctx = withClock(
      h.ctx,
      steppingClock('2026-10-16T08:00:00.000Z', '2026-10-16T08:00:02.500Z'),
    );
    const earlier = { step: 'collect' as const, ms: 40 };

    const next = await stage(ctx, 'classify', ok).run(stateOf({ timings: [earlier] }));

    expect(next.timings).toEqual([earlier, { step: 'classify', ms: 2500 }]);
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        message: 'Step finished',
        fields: expect.objectContaining({ ms: 2500 }) as object,
      }),
    );
  });

  it('returns a settled state untouched, running nothing', async () => {
    const h = contextFor();
    const fn = vi.fn<StageFn>(ok);
    const settled = stateOf({ settled: { status: 'quiet', note: 'no items collected' } });

    const next = await stage(h.ctx, 'classify', fn).run(settled);

    expect(next).toBe(settled);
    expect(fn).not.toHaveBeenCalled();
    expect(h.spans).toEqual([]);
  });

  it('names the step that settled the run, whatever the stage said', async () => {
    const h = contextFor();
    const settling: StageFn = (_ctx, state) =>
      Promise.resolve({
        ...state,
        settled: { status: 'blocked', note: 'every draft was rejected' },
      });

    const next = await stage(h.ctx, 'guardOutput', settling).run(stateOf());

    expect(next.settled).toEqual({
      status: 'blocked',
      note: 'every draft was rejected',
      step: 'guardOutput',
    });
  });

  it('fails with the state it started from, plus the failed step timing, when the stage throws', async () => {
    const h = contextFor();
    const cause = new DigestError('classify: bad answer', { step: 'classify' });
    const earlier = { step: 'collect' as const, ms: 40 };
    const state = stateOf({ timings: [earlier] });

    const failure = await stage(h.ctx, 'classify', () => Promise.reject(cause))
      .run(state)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(StepFailure);
    expect(failure).toMatchObject({ step: 'classify', cause });
    expect((failure as StepFailure).state.timings).toEqual([earlier, { step: 'classify', ms: 0 }]);
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        level: 'error',
        message: 'Step failed',
        fields: expect.objectContaining({ error: 'classify: bad answer' }) as object,
      }),
    );
  });

  it('keeps the partial work of a stage that threw a PartialFailure, and the cause behind it', async () => {
    const h = contextFor();
    const partial = stateOf({ sentUrls: ['https://example.com/a'] });
    const cause = new Error('Delivery failed on email');

    const failure = await stage(h.ctx, 'deliver', () =>
      Promise.reject(new PartialFailure(partial, cause)),
    )
      .run(stateOf())
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(StepFailure);
    expect(failure).toMatchObject({ step: 'deliver', cause });
    expect((failure as StepFailure).state.sentUrls).toEqual(['https://example.com/a']);
    expect((failure as StepFailure).state.timings).toEqual([{ step: 'deliver', ms: 0 }]);
  });

  describe('when the run was told to stop', () => {
    it('fails before the stage, keeping the state, and runs nothing', async () => {
      const controller = new AbortController();
      controller.abort(new Error('scheduler timeout after 2h'));
      const h = contextFor({ signal: controller.signal });
      const fn = vi.fn<StageFn>(ok);
      const state = stateOf({ sentUrls: ['https://example.com/a'] });

      const failure = await stage(h.ctx, 'write', fn)
        .run(state)
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(StepFailure);
      expect(failure).toMatchObject({
        step: 'write',
        state,
        message: 'Run aborted before the write step: scheduler timeout after 2h',
      });
      expect(fn).not.toHaveBeenCalled();
      expect(h.logs).toContainEqual(
        expect.objectContaining({
          level: 'warn',
          message: 'Run aborted',
          fields: { runId: WEEK, step: 'write', reason: 'scheduler timeout after 2h' },
        }),
      );
    });

    it('fails a stage that was running when the signal fired as an abort, which no retry follows', async () => {
      const controller = new AbortController();
      const h = contextFor({ signal: controller.signal });
      const earlier = { step: 'collect' as const, ms: 40 };
      const state = stateOf({ timings: [earlier] });
      const aborting: StageFn = () => {
        controller.abort(new Error('run timed out after 2 h'));
        return Promise.reject(new Error('The operation was aborted'));
      };

      const failure = await stage(h.ctx, 'collect', aborting)
        .run(state)
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(StepFailure);
      const { cause } = failure as StepFailure;
      expect(cause).toBeInstanceOf(DigestError);
      expect((cause as DigestError).message).toBe(
        'Run aborted during the collect step: run timed out after 2 h',
      );
      expect(isUnretriable((cause as DigestError).message)).toBe(true);
      expect((failure as StepFailure).state.timings).toEqual([earlier, { step: 'collect', ms: 0 }]);
      expect(h.logs).toContainEqual(
        expect.objectContaining({
          level: 'error',
          message: 'Step failed',
          fields: expect.objectContaining({
            error: 'Run aborted during the collect step: run timed out after 2 h',
            thrown: 'The operation was aborted',
          }) as object,
        }),
      );
    });

    it('keeps what the step threw in the log, so a real failure during an abort is not lost', async () => {
      const controller = new AbortController();
      const h = contextFor({ signal: controller.signal });
      const failing: StageFn = () => {
        controller.abort(new Error('run timed out'));
        return Promise.reject(new PartialFailure(stateOf(), new Error('SMTP 554 rejected')));
      };

      await stage(h.ctx, 'deliver', failing)
        .run(stateOf())
        .catch(() => undefined);

      expect(h.logs).toContainEqual(
        expect.objectContaining({
          message: 'Step failed',
          fields: expect.objectContaining({
            error: 'Run aborted during the deliver step: run timed out',
            thrown: 'SMTP 554 rejected',
          }) as object,
        }),
      );
    });

    it('keeps the partial work of a stage that failed after the signal fired', async () => {
      const controller = new AbortController();
      const h = contextFor({ signal: controller.signal });
      const partial = stateOf({ sentUrls: ['https://example.com/a'] });
      const aborting: StageFn = () => {
        controller.abort(new Error('run timed out'));
        return Promise.reject(new PartialFailure(partial, new Error('Delivery failed on email')));
      };

      const failure = await stage(h.ctx, 'deliver', aborting)
        .run(stateOf())
        .catch((error: unknown) => error);

      expect(failure).toMatchObject({
        step: 'deliver',
        message: 'Run aborted during the deliver step: run timed out',
      });
      expect((failure as StepFailure).state.sentUrls).toEqual(['https://example.com/a']);
    });

    it('leaves the failure of a stage alone when the signal has not fired', async () => {
      const h = contextFor({ signal: new AbortController().signal });
      const cause = new DigestError('classify: bad answer', { step: 'classify' });

      const failure = await stage(h.ctx, 'classify', () => Promise.reject(cause))
        .run(stateOf())
        .catch((error: unknown) => error);

      expect(failure).toMatchObject({ step: 'classify', cause });
    });

    it('lets a settled run finish quietly: it has nothing left to stop', async () => {
      const controller = new AbortController();
      controller.abort();
      const h = contextFor({ signal: controller.signal });
      const settled = stateOf({ settled: { status: 'quiet' } });

      await expect(stage(h.ctx, 'write', ok).run(settled)).resolves.toBe(settled);
    });
  });
});
