import { describe, expect, it } from 'vitest';
import { stopBeforeSending } from './sendGuard';
import { isUnretriable } from '../notes/unretriable';
import { WEEK, contextFor, lostLock } from '../../__fixtures__/stageKit';
import { makeRunRecord } from '../../../../test/builders';

const sent = makeRunRecord({ runId: WEEK, status: 'sent', deliveredTo: ['markdown', 'email'] });
const partly = makeRunRecord({ runId: WEEK, status: 'failed', deliveredTo: ['markdown'] });

describe('stopBeforeSending', () => {
  it('lets the send go while the week is as the run found it and nothing told it to stop', async () => {
    const h = contextFor();
    h.store.records.set(WEEK, partly);

    await expect(stopBeforeSending(h.ctx, partly, h.logger)).resolves.toBeUndefined();
  });

  it('stops a run that another run beat to a channel, and says so in the log', async () => {
    const h = contextFor();
    h.store.records.set(WEEK, sent);

    const stopped = await stopBeforeSending(h.ctx, partly, h.logger);

    expect(stopped?.message).toBe(
      `Run aborted before the deliver step: another run delivered ${WEEK} while this one worked`,
    );
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: 'Another run delivered this week',
        fields: { runId: WEEK, status: 'sent', channels: ['markdown', 'email'] },
      }),
    );
  });

  it('stops a run whose signal fired, with its reason: here a lost lock', async () => {
    const h = contextFor({ lockLost: lostLock() });

    const stopped = await stopBeforeSending(h.ctx, undefined, h.logger);

    expect(stopped?.message).toMatch(
      /^Run aborted before the deliver step: this run lost its lock/,
    );
    expect(stopped?.step).toBe('deliver');
    expect(isUnretriable(stopped?.message)).toBe(true);
  });

  it('lets a failed read through: no guess about the week', async () => {
    const h = contextFor();
    h.store.getRunRecord = () => Promise.reject(new Error('EIO'));

    await expect(stopBeforeSending(h.ctx, undefined, h.logger)).rejects.toThrow('EIO');
  });
});
