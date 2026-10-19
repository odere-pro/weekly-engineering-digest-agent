import { describe, expect, it } from 'vitest';
import { RecordNotSavedError, saveRecord } from './saveRecord';
import { DigestError } from '../../shared/errors';
import { WEEK, record, setupEnding } from './__fixtures__/endingKit';

describe('saveRecord', () => {
  it('saves the record and says nothing', async () => {
    const h = setupEnding();
    const sent = record({ status: 'sent' });

    await saveRecord(h.ctx, sent);

    expect(h.store.records.get(WEEK)).toBe(sent);
    expect(h.logs).toEqual([]);
  });

  it('logs the cause, alerts every channel and throws RecordNotSavedError with the cause', async () => {
    const h = setupEnding();
    const cause = new Error('disk full');
    h.store.saveRunRecord = () => Promise.reject(cause);

    const thrown = await saveRecord(h.ctx, record({ status: 'sent' })).catch((e: unknown) => e);

    const message = 'Could not save the run record (disk full); the run ended sent';
    expect(thrown).toBeInstanceOf(RecordNotSavedError);
    expect(thrown).toBeInstanceOf(DigestError);
    expect(thrown).toMatchObject({ name: 'RecordNotSavedError', message, cause });
    expect(h.logs).toContainEqual({
      level: 'error',
      message: 'Could not save the run record',
      fields: { error: 'disk full' },
    });
    for (const delivery of h.deliveries) {
      expect(delivery.failures).toEqual([{ weekId: WEEK, message }]);
    }
  });

  it('names the failure of a run that ended failed', async () => {
    const h = setupEnding();
    h.store.saveRunRecord = () => Promise.reject(new Error('EROFS'));
    const failed = record({ status: 'failed', error: { message: 'classifier timed out' } });

    await expect(saveRecord(h.ctx, failed)).rejects.toThrow(
      'Could not save the run record (EROFS); the run failed: classifier timed out',
    );
  });

  it('sends no alert in a dry run, and still throws', async () => {
    const h = setupEnding({ dryRun: true });
    h.store.saveRunRecord = () => Promise.reject(new Error('disk full'));

    await expect(saveRecord(h.ctx, record({ status: 'dry-run' }))).rejects.toBeInstanceOf(
      RecordNotSavedError,
    );

    expect(h.deliveries.flatMap((delivery) => delivery.failures)).toEqual([]);
  });
});
