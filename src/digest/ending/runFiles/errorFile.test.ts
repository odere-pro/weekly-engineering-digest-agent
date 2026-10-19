import { describe, expect, it } from 'vitest';
import { recordError, saveErrorFile } from './errorFile';
import { DigestError } from '../../../shared/errors';
import { WEEK, setupEnding } from '../__fixtures__/endingKit';

const AT = new Date('2026-10-16T08:00:00.000Z');
const errorJson = (h: ReturnType<typeof setupEnding>): unknown =>
  JSON.parse(h.store.artifacts.get(`${WEEK}/error.json`) ?? '{}');

describe('recordError', () => {
  it('turns a failure into the record error', () => {
    expect(recordError({ error: new Error('timed out'), step: 'write' })).toEqual({
      message: 'timed out',
      step: 'write',
    });
  });

  it('names a thrown value that is not an error, and has no step outside a step', () => {
    expect(recordError({ error: 'boom' })).toEqual({ message: 'boom', step: undefined });
  });
});

describe('saveErrorFile', () => {
  it('writes the run, step, error name, message, time and stack', async () => {
    const h = setupEnding();
    const error = new DigestError('Delivery failed on email', { step: 'deliver' });

    await saveErrorFile(h.ctx, { error, step: 'deliver' }, AT);

    expect(errorJson(h)).toEqual({
      runId: WEEK,
      step: 'deliver',
      name: 'DigestError',
      message: 'Delivery failed on email',
      at: AT.toISOString(),
      stack: error.stack,
    });
  });

  it('names a thrown non-error plainly', async () => {
    const h = setupEnding();

    await saveErrorFile(h.ctx, { error: 'boom' }, AT);

    expect(errorJson(h)).toMatchObject({ name: 'Error', message: 'boom' });
    expect(errorJson(h)).not.toHaveProperty('stack');
  });

  it('logs a file it cannot write and does not throw', async () => {
    const h = setupEnding();
    h.store.saveArtifact = () => Promise.reject(new Error('EROFS'));

    await expect(saveErrorFile(h.ctx, { error: new Error('x') }, AT)).resolves.toBeUndefined();

    expect(h.logs).toEqual([
      { level: 'error', message: 'Could not write error.json', fields: { error: 'EROFS' } },
    ]);
  });
});
