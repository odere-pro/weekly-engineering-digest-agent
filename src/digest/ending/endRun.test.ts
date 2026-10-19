import { describe, expect, it, vi } from 'vitest';
import { endRun } from './endRun';
import { failureNote } from './notes/failureNotes';
import type { HeldArtifact } from './types';
import type { RunRecord } from '../../store/runRecord';
import { DigestError } from '../../shared/errors';
import { makeClassification, makeDraft, makeItem } from '../../../test/builders';
import type { MemoryRunStore } from '../../../test/fakes';
import { WEEK, partly, record, sent, setupEnding } from './__fixtures__/endingKit';

/** The new record replaces the earlier one; otherwise a test names the warning. */
const SAVED = undefined;

describe('endRun: which record stays', () => {
  it.each<[string, RunRecord | undefined, RunRecord, string | undefined]>([
    ['no earlier record', undefined, record({ status: 'quiet' }), SAVED],
    [
      'a failed record that reached no channel',
      record({ status: 'failed' }),
      record({ status: 'dry-run' }),
      SAVED,
    ],
    ['a sent record, by a sent one', record({ status: 'sent' }), record({ status: 'sent' }), SAVED],
    [
      'a sent record, by a partly delivered one',
      record({ status: 'sent' }),
      partly,
      'Kept the sent run record; this forced run did not end sent',
    ],
    [
      'a partly delivered record, by a dry run',
      partly,
      record({ status: 'dry-run' }),
      'Kept the partly delivered run record; this run delivered nothing',
    ],
    [
      'a partly delivered record, by another',
      partly,
      record({ status: 'failed', deliveredTo: ['email'] }),
      SAVED,
    ],
    ['a partly delivered record, by a sent one', partly, record({ status: 'sent' }), SAVED],
  ])('handles %s', async (_name, previous, next, expected) => {
    const h = setupEnding();
    if (previous) h.store.records.set(WEEK, previous);

    const ended = await endRun(h.ctx, { record: next }, previous);

    expect(ended.kept).toBe(expected);
    expect(h.store.records.get(WEEK)).toBe(expected === SAVED ? next : previous);
    const warned = h.logs.filter((line) => line.level === 'warn').map((line) => line.message);
    expect(warned).toEqual(expected === SAVED ? [] : [expected]);
  });
});

const held: readonly HeldArtifact[] = [
  { name: 'items.json', content: '[]\n' },
  { name: 'digest.md', content: '# New wording\n' },
];
const writtenFiles = (store: MemoryRunStore): string[] => [...store.artifacts.keys()].sort();

describe('endRun: artifacts held for the record', () => {
  it('writes them once the record is saved, and says which', async () => {
    const h = setupEnding();
    const order: string[] = [];
    const saveRecord = h.store.saveRunRecord.bind(h.store);
    vi.spyOn(h.store, 'saveRunRecord').mockImplementation((next) => {
      order.push('record');
      return saveRecord(next);
    });
    const saveArtifact = h.store.saveArtifact.bind(h.store);
    vi.spyOn(h.store, 'saveArtifact').mockImplementation((runId, name, content) => {
      order.push(name);
      return saveArtifact(runId, name, content);
    });

    const ended = await endRun(h.ctx, { record: sent, artifacts: held }, partly);

    expect(order).toEqual(['record', 'items.json', 'digest.md']);
    expect(h.store.artifacts.get(`${WEEK}/digest.md`)).toBe('# New wording\n');
    expect(ended.written).toEqual(new Set(['items.json', 'digest.md']));
    expect(ended).not.toHaveProperty('kept');
  });

  it('writes nothing when the earlier record stays: no artifact, no error.json', async () => {
    const h = setupEnding();
    h.store.records.set(WEEK, sent);
    h.store.artifacts.set(`${WEEK}/digest.md`, '# Sent wording\n');
    const failure = { error: new Error('delivery failed'), step: 'deliver' as const };
    const note = failureNote(WEEK, failure);

    const { written, kept } = await endRun(
      h.ctx,
      { record: partly, failure, note, artifacts: held },
      sent,
    );

    expect(written).toEqual(new Set());
    expect(kept).toBe('Kept the sent run record; this forced run did not end sent');
    expect(h.store.records.get(WEEK)).toBe(sent);
    expect(writtenFiles(h.store)).toEqual([`${WEEK}/digest.md`]);
    expect(h.store.artifacts.get(`${WEEK}/digest.md`)).toBe('# Sent wording\n');
    // The failure is still reported: the person running the week needs to know.
    for (const delivery of h.deliveries) expect(delivery.failures).toEqual([note]);
  });

  it('keeps a partly delivered week files too when a run delivered nothing', async () => {
    const h = setupEnding();
    h.store.records.set(WEEK, partly);

    const { written, kept } = await endRun(
      h.ctx,
      { record: record({ status: 'dry-run' }), artifacts: held },
      partly,
    );

    expect(written).toEqual(new Set());
    expect(kept).toBe('Kept the partly delivered run record; this run delivered nothing');
    expect(writtenFiles(h.store)).toEqual([]);
  });

  it('logs a held artifact that cannot be saved and still writes the others', async () => {
    const h = setupEnding();
    const saveArtifact = h.store.saveArtifact.bind(h.store);
    vi.spyOn(h.store, 'saveArtifact').mockImplementation((runId, name, content) =>
      name === 'items.json'
        ? Promise.reject(new Error('EROFS'))
        : saveArtifact(runId, name, content),
    );

    const { written } = await endRun(h.ctx, { record: sent, artifacts: held }, partly);

    expect(written).toEqual(new Set(['digest.md']));
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        level: 'error',
        message: 'Could not write items.json',
        fields: { error: 'EROFS' },
      }),
    );
  });

  it('writes nothing held when the record cannot be saved', async () => {
    const h = setupEnding();
    vi.spyOn(h.store, 'saveRunRecord').mockRejectedValue(new Error('disk full'));

    await expect(endRun(h.ctx, { record: sent, artifacts: held }, undefined)).rejects.toThrow(
      DigestError,
    );

    expect(writtenFiles(h.store)).toEqual([]);
  });

  it('has nothing to write when the run held no artifacts', async () => {
    const h = setupEnding();

    const { written } = await endRun(h.ctx, { record: sent }, undefined);

    expect(written).toEqual(new Set());
  });
});

describe('endRun: error file, note and pruning', () => {
  it('writes error.json with the step and the stack, and sends the note to every channel', async () => {
    const h = setupEnding();
    const error = new DigestError('Delivery failed on email (SMTP 451)', { step: 'deliver' });
    const failure = { error, step: 'deliver' as const };
    const note = failureNote(WEEK, failure);

    await endRun(h.ctx, { record: record({ status: 'failed' }), failure, note }, undefined);

    expect(JSON.parse(h.store.artifacts.get(`${WEEK}/error.json`) ?? '{}')).toEqual({
      runId: WEEK,
      step: 'deliver',
      name: 'DigestError',
      message: 'Delivery failed on email (SMTP 451)',
      at: '2026-10-16T08:00:00.000Z',
      stack: error.stack,
    });
    for (const delivery of h.deliveries) {
      expect(delivery.failures).toEqual([
        { weekId: WEEK, step: 'deliver', message: 'Delivery failed on email (SMTP 451)' },
      ]);
    }
  });

  it('names a thrown non-error plainly in error.json', async () => {
    const h = setupEnding();

    await endRun(
      h.ctx,
      { record: record({ status: 'failed' }), failure: { error: 'boom' } },
      undefined,
    );

    expect(JSON.parse(h.store.artifacts.get(`${WEEK}/error.json`) ?? '{}')).toMatchObject({
      name: 'Error',
      message: 'boom',
    });
  });

  it('sends no note in a dry run', async () => {
    const h = setupEnding({ dryRun: true });
    const note = { weekId: WEEK, message: 'no items collected' };

    await endRun(h.ctx, { record: record({ status: 'quiet' }), note }, undefined);

    expect(h.deliveries.flatMap((delivery) => delivery.failures)).toEqual([]);
  });

  it('logs a channel that refuses the note, a failed error.json and a failed prune', async () => {
    const h = setupEnding();
    vi.spyOn(h.deliveries[0]!, 'sendFailure').mockRejectedValue(new Error('webhook 500'));
    const save = h.store.saveArtifact.bind(h.store);
    vi.spyOn(h.store, 'saveArtifact').mockImplementation((runId, name, content) =>
      name === 'error.json' ? Promise.reject(new Error('EROFS')) : save(runId, name, content),
    );
    vi.spyOn(h.store, 'prune').mockRejectedValue(new Error('EACCES'));
    const failure = { error: new Error('classifier timed out'), step: 'classify' as const };

    await endRun(
      h.ctx,
      { record: record({ status: 'failed' }), failure, note: failureNote(WEEK, failure) },
      undefined,
    );

    const errors = h.logs.filter((line) => line.level === 'error');
    expect(errors.map((line) => line.fields.error)).toEqual(['EROFS', 'webhook 500', 'EACCES']);
    expect(h.store.records.get(WEEK)?.status).toBe('failed');
  });

  it('prunes with keepWeeks and logs what it pruned', async () => {
    const h = setupEnding();
    const prune = vi.spyOn(h.store, 'prune').mockResolvedValue(['2026-W30']);

    await endRun(h.ctx, { record: record({ status: 'sent' }) }, undefined);

    expect(prune).toHaveBeenCalledWith(WEEK, 6);
    expect(h.logs).toContainEqual(
      expect.objectContaining({ message: 'Pruned old runs', fields: { pruned: ['2026-W30'] } }),
    );
  });

  it('alerts every channel, then throws, when the record cannot be saved', async () => {
    const h = setupEnding();
    vi.spyOn(h.store, 'saveRunRecord').mockRejectedValue(new Error('disk full'));
    const failed = record({ status: 'failed', error: { message: 'classifier timed out' } });

    const thrown = await endRun(h.ctx, { record: failed }, undefined).catch((e: unknown) => e);

    const message =
      'Could not save the run record (disk full); the run failed: classifier timed out';
    expect(thrown).toBeInstanceOf(DigestError);
    expect((thrown as DigestError).message).toBe(message);
    for (const delivery of h.deliveries) {
      expect(delivery.failures).toEqual([{ weekId: WEEK, message }]);
    }
  });
});

describe('endRun: review sheet', () => {
  const items = [1, 2].map((n) =>
    makeItem({ id: `r${n}`, title: `Release ${n}`, url: `https://example.com/r/${n}` }),
  );
  const files: readonly HeldArtifact[] = [
    { name: 'items.json', content: JSON.stringify(items) },
    { name: 'scores.json', content: JSON.stringify(items.map((i) => makeClassification(i.id))) },
    { name: 'drafts.json', content: JSON.stringify({ drafts: [makeDraft([items[0]!], 'w1')] }) },
  ];
  const withWinner = record({ status: 'dry-run', winner: 'w1' });

  it('writes review.md once the record is saved', async () => {
    const h = setupEnding({ dryRun: true });

    await endRun(h.ctx, { record: withWinner, artifacts: files }, undefined);

    expect(h.store.artifacts.get(`${WEEK}/review.md`)).toContain('`r1`');
  });

  it('writes no sheet when the earlier record stayed', async () => {
    const h = setupEnding();
    h.store.records.set(WEEK, sent);

    await endRun(h.ctx, { record: withWinner, artifacts: files }, sent);

    expect(h.store.artifacts.get(`${WEEK}/review.md`)).toBeUndefined();
  });
});
