import { describe, expect, it, vi } from 'vitest';
import {
  endRun,
  failureNote,
  forEachDelivery,
  recordError,
  type EndingContext,
} from '../../src/core/runEnding.js';
import type { RunRecord } from '../../src/core/schemas.js';
import { DigestError } from '../../src/shared/errors.js';
import type { LogFields, Logger } from '../../src/shared/telemetry.js';
import { makeRunRecord } from '../builders.js';
import { CapturingDelivery, MemoryRunStore } from '../fakes/index.js';

const WEEK = '2026-W42';

interface LogLine {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  fields: LogFields;
}

function recordingLogger(lines: LogLine[]): Logger {
  const at =
    (level: LogLine['level']) =>
    (message: string, fields: LogFields = {}): void => {
      lines.push({ level, message, fields });
    };
  const logger: Logger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => logger,
  };
  return logger;
}

function setup(dryRun = false) {
  const logs: LogLine[] = [];
  const store = new MemoryRunStore();
  const deliveries = [new CapturingDelivery('markdown'), new CapturingDelivery('email')];
  const ctx: EndingContext = {
    weekId: WEEK,
    dryRun,
    logger: recordingLogger(logs),
    deps: { store, deliveries, config: { keepWeeks: 6 } },
  };
  return { ctx, store, deliveries, logs };
}

const record = (overrides: Partial<RunRecord>): RunRecord =>
  makeRunRecord({ runId: WEEK, finishedAt: '2026-10-16T08:00:00.000Z', ...overrides });
const partly = record({ status: 'failed', deliveredTo: ['markdown'] });
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
      'Kept the sent run record; this forced run did not send',
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
    const h = setup();
    if (previous) h.store.records.set(WEEK, previous);

    await endRun(h.ctx, { record: next }, previous);

    expect(h.store.records.get(WEEK)).toBe(expected === SAVED ? next : previous);
    const warned = h.logs.filter((line) => line.level === 'warn').map((line) => line.message);
    expect(warned).toEqual(expected === SAVED ? [] : [expected]);
  });
});

describe('endRun: error file, note and pruning', () => {
  it('writes error.json with the step and the stack, and sends the note to every channel', async () => {
    const h = setup();
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
    const h = setup();

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
    const h = setup(true);
    const note = { weekId: WEEK, message: 'no items collected' };

    await endRun(h.ctx, { record: record({ status: 'quiet' }), note }, undefined);

    expect(h.deliveries.flatMap((delivery) => delivery.failures)).toEqual([]);
  });

  it('logs a channel that refuses the note, a failed error.json and a failed prune', async () => {
    const h = setup();
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
    const h = setup();
    const prune = vi.spyOn(h.store, 'prune').mockResolvedValue(['2026-W30']);

    await endRun(h.ctx, { record: record({ status: 'sent' }) }, undefined);

    expect(prune).toHaveBeenCalledWith(WEEK, 6);
    expect(h.logs).toContainEqual(
      expect.objectContaining({ message: 'Pruned old runs', fields: { pruned: ['2026-W30'] } }),
    );
  });

  it('alerts every channel, then throws, when the record cannot be saved', async () => {
    const h = setup();
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

describe('runEnding helpers', () => {
  it('turns a failure into the record error', () => {
    expect(recordError({ error: new Error('timed out'), step: 'write' })).toEqual({
      message: 'timed out',
      step: 'write',
    });
  });

  it('tries every channel and returns the ones that failed', async () => {
    const [markdown, email] = [new CapturingDelivery('markdown'), new CapturingDelivery('email')];
    email.failWith = new Error('SMTP 554');
    const message = { weekId: WEEK, subject: 'Digest', markdown: '# Digest\n' };

    const failures = await forEachDelivery([email, markdown], (d) => d.sendDigest(message));

    expect(failures).toEqual([{ id: 'email', error: 'SMTP 554' }]);
    expect(markdown.digests).toEqual([message]);
  });
});
