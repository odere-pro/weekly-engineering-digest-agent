import { describe, expect, it } from 'vitest';
import { failureNote, sendHeldNote } from './failureNotes';
import { endRun } from '../endRun';
import { recordError } from '../runFiles/errorFile';
import type { Failure } from '../types';
import type { RunRecord } from '../../../store/runRecord';
import { DigestError } from '../../../shared/errors';
import { makeRunRecord } from '../../../../test/builders';
import { WEEK, setupEnding } from '../__fixtures__/endingKit';

const failedRecord = (overrides: Partial<RunRecord> = {}): RunRecord =>
  makeRunRecord({
    runId: WEEK,
    status: 'failed',
    finishedAt: '2026-10-16T08:00:00.000Z',
    error: { message: 'Ollama is not reachable', step: 'write' },
    ...overrides,
  });

function failure(error: unknown = new DigestError('Ollama is not reachable'), step?: 'write') {
  const failed: Failure = { error, step };
  return { failure: failed, note: failureNote(WEEK, failed) };
}

const notesOf = (h: ReturnType<typeof setupEnding>) => h.deliveries.map((d) => d.failures.length);

describe('sendHeldNote', () => {
  const heldRecord = (overrides: Partial<RunRecord> = {}): RunRecord =>
    failedRecord({ error: { message: 'Ollama is not reachable', step: 'write' }, ...overrides });

  it('sends the note the run would have sent, to every channel, once', async () => {
    const h = setupEnding();

    await sendHeldNote({ deliveries: h.deliveries, logger: h.ctx.logger }, WEEK, heldRecord());

    expect(h.deliveries.map((delivery) => delivery.failures)).toEqual([
      [{ weekId: WEEK, step: 'write', message: 'Ollama is not reachable' }],
      [{ weekId: WEEK, step: 'write', message: 'Ollama is not reachable' }],
    ]);
  });

  it('is the same note endRun sends for that failure', async () => {
    const held = setupEnding({ notifyFailure: false });
    const sent = setupEnding();
    const error = new DigestError('Ollama is not reachable');
    const record = failedRecord({ error: recordError({ error, step: 'write' }) });

    await endRun(held.ctx, { record, ...failure(error, 'write') }, undefined);
    await sendHeldNote({ deliveries: held.deliveries, logger: held.ctx.logger }, WEEK, record);
    await endRun(sent.ctx, { record, ...failure(error, 'write') }, undefined);

    expect(held.deliveries.map((d) => d.failures)).toEqual(sent.deliveries.map((d) => d.failures));
  });

  it('names a failure that has no recorded error', async () => {
    const h = setupEnding();
    const record = failedRecord();
    const { error: _error, ...withoutError } = record;

    await sendHeldNote({ deliveries: h.deliveries, logger: h.ctx.logger }, WEEK, withoutError);

    expect(h.deliveries[0]?.failures[0]).toEqual({
      weekId: WEEK,
      step: undefined,
      message: 'The run ended failed',
    });
  });

  it('leaves the other channels their note when one cannot take it, and logs it', async () => {
    const h = setupEnding();
    const [first] = h.deliveries;
    if (first) first.sendFailure = () => Promise.reject(new Error('mail server is down'));

    await sendHeldNote({ deliveries: h.deliveries, logger: h.ctx.logger }, WEEK, heldRecord());

    expect(h.deliveries[1]?.failures).toHaveLength(1);
    expect(h.logs).toContainEqual({
      level: 'error',
      message: 'Could not send the failure note',
      fields: { delivery: 'markdown', error: 'mail server is down' },
    });
  });

  it('sends nothing for a record of a dry run', async () => {
    const h = setupEnding();

    await sendHeldNote(
      { deliveries: h.deliveries, logger: h.ctx.logger },
      WEEK,
      heldRecord({ dryRun: true }),
    );

    expect(notesOf(h)).toEqual([0, 0]);
  });
});
