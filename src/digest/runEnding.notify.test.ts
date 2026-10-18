// W5-12: `notifyFailure` holds the failure note back for a run its caller will try again.
import { describe, expect, it } from 'vitest';
import {
  abortedError,
  endRun,
  failureNote,
  isUnretriable,
  needsForce,
  RecordNotSavedError,
  recordError,
  sendHeldNote,
  type EndingContext,
  type Failure,
} from './runEnding';
import type { RunRecord } from '../domain/schemas';
import { DigestError } from '../shared/errors';
import type { LogFields, Logger } from '../shared/telemetry';
import { makeRunRecord } from '../../test/builders';
import { CapturingDelivery, MemoryRunStore } from '../../test/fakes';

const WEEK = '2026-W42';
const HELD_BACK = 'Failure note held back: notifyFailure is off for this run';

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

function setup(context: Partial<EndingContext> = {}) {
  const logs: LogLine[] = [];
  const store = new MemoryRunStore();
  const deliveries = [new CapturingDelivery('markdown'), new CapturingDelivery('email')];
  const ctx: EndingContext = {
    weekId: WEEK,
    dryRun: false,
    logger: recordingLogger(logs),
    deps: { store, deliveries, config: { keepWeeks: 6 } },
    ...context,
  };
  return { ctx, store, deliveries, logs };
}

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

const notesOf = (h: ReturnType<typeof setup>) => h.deliveries.map((d) => d.failures.length);
const heldLogs = (h: ReturnType<typeof setup>) =>
  h.logs.filter((line) => line.message === HELD_BACK);

describe('endRun: notifyFailure', () => {
  it('sends the note to every channel when the option is left out', async () => {
    const h = setup();

    await endRun(h.ctx, { record: failedRecord(), ...failure() }, undefined);

    expect(notesOf(h)).toEqual([1, 1]);
    expect(heldLogs(h)).toEqual([]);
  });

  it('sends the note when notifyFailure is true', async () => {
    const h = setup({ notifyFailure: true });

    await endRun(h.ctx, { record: failedRecord(), ...failure() }, undefined);

    expect(notesOf(h)).toEqual([1, 1]);
  });

  describe('when it is false', () => {
    it('still saves the record and error.json, and sends no note', async () => {
      const h = setup({ notifyFailure: false });
      const record = failedRecord();

      const ended = await endRun(h.ctx, { record, ...failure() }, undefined);

      expect(h.store.records.get(WEEK)).toBe(record);
      expect(h.store.artifacts.has(`${WEEK}/error.json`)).toBe(true);
      expect(notesOf(h)).toEqual([0, 0]);
      expect(ended.kept).toBeUndefined();
    });

    it('says in the log that the note was held back, once, with the step', async () => {
      const h = setup({ notifyFailure: false });

      await endRun(h.ctx, { record: failedRecord(), ...failure(undefined, 'write') }, undefined);

      expect(heldLogs(h)).toEqual([
        { level: 'info', message: HELD_BACK, fields: { step: 'write' } },
      ]);
    });

    it('still prunes old runs and logs how the run finished', async () => {
      const h = setup({ notifyFailure: false });
      h.store.records.set('2025-W01', makeRunRecord({ runId: '2025-W01' }));

      await endRun(h.ctx, { record: failedRecord(), ...failure() }, undefined);

      expect(h.store.records.has('2025-W01')).toBe(false);
      expect(h.logs.map((line) => line.message)).toContain('Run finished');
    });

    it('sends the note of a run that was told to stop, which nobody will retry', async () => {
      const controller = new AbortController();
      controller.abort(new Error('run timed out after 3 h'));
      const stopped = abortedError(controller.signal, 'write');
      const h = setup({ notifyFailure: false });

      await endRun(h.ctx, { record: failedRecord(), ...failure(stopped, 'write') }, undefined);

      expect(notesOf(h)).toEqual([1, 1]);
      expect(heldLogs(h)).toEqual([]);
    });

    it('goes by the failure, not by the signal: any other failure of a stopped run is held', async () => {
      // The caller reads the same failure to know whether the run sent its note, so the signal
      // (which can fire between the run's decision and the caller's look) must not decide.
      const h = setup({ notifyFailure: false });

      await endRun(h.ctx, { record: failedRecord(), ...failure() }, undefined);

      expect(notesOf(h)).toEqual([0, 0]);
    });

    it('sends the note of a resume that only --force can clear, which a retry cannot fix', async () => {
      const h = setup({ notifyFailure: false });
      const error = new DigestError(
        'digest.md no longer matches the digest markdown got; run with --force to send a new digest to every channel',
      );

      await endRun(h.ctx, { record: failedRecord(), ...failure(error) }, undefined);

      expect(notesOf(h)).toEqual([1, 1]);
      expect(heldLogs(h)).toEqual([]);
    });

    it('sends the note of a run that is not a failure (a blocked week)', async () => {
      const h = setup({ notifyFailure: false });
      const record = makeRunRecord({ runId: WEEK, status: 'blocked' });
      const note = { weekId: WEEK, step: 'guardInput' as const, message: 'Every item was blocked' };

      await endRun(h.ctx, { record, note }, undefined);

      expect(notesOf(h)).toEqual([1, 1]);
      expect(heldLogs(h)).toEqual([]);
    });

    it('sends the note that says the run record could not be saved', async () => {
      const h = setup({ notifyFailure: false });
      h.store.saveRunRecord = () => Promise.reject(new Error('disk full'));

      await expect(
        endRun(h.ctx, { record: failedRecord(), ...failure() }, undefined),
      ).rejects.toThrow('Could not save the run record (disk full)');

      expect(notesOf(h)).toEqual([1, 1]);
      expect(h.deliveries[0]?.failures[0]?.message).toContain('Could not save the run record');
    });

    it('throws an error that says it already sent its note, for a caller that holds another', async () => {
      const h = setup({ notifyFailure: false });
      h.store.saveRunRecord = () => Promise.reject(new Error('disk full'));

      const error = await endRun(h.ctx, { record: failedRecord(), ...failure() }, undefined).catch(
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(RecordNotSavedError);
      expect(error).toBeInstanceOf(DigestError);
      expect((error as Error).cause).toBeInstanceOf(Error);
    });

    it('sends no note about an unsaved record in a dry run, and still throws', async () => {
      const h = setup({ dryRun: true });
      h.store.saveRunRecord = () => Promise.reject(new Error('disk full'));

      await expect(
        endRun(h.ctx, { record: failedRecord(), ...failure() }, undefined),
      ).rejects.toBeInstanceOf(RecordNotSavedError);

      expect(notesOf(h)).toEqual([0, 0]);
    });

    it('holds the note and keeps the earlier record when a sent week stays', async () => {
      const h = setup({ notifyFailure: false });
      const sent = makeRunRecord({ runId: WEEK, status: 'sent' });
      h.store.records.set(WEEK, sent);

      const ended = await endRun(h.ctx, { record: failedRecord(), ...failure() }, sent);

      expect(ended.kept).toContain('Kept the sent run record');
      expect(notesOf(h)).toEqual([0, 0]);
    });

    it('sends no note and logs nothing about one in a dry run', async () => {
      const h = setup({ notifyFailure: false, dryRun: true });

      await endRun(h.ctx, { record: failedRecord(), ...failure() }, undefined);

      expect(notesOf(h)).toEqual([0, 0]);
      expect(heldLogs(h)).toEqual([]);
    });

    it('has nothing to hold when the run made no note', async () => {
      const h = setup({ notifyFailure: false });

      await endRun(h.ctx, { record: makeRunRecord({ runId: WEEK, status: 'sent' }) }, undefined);

      expect(heldLogs(h)).toEqual([]);
    });

    it('records the same error as when the note is sent', async () => {
      const held = setup({ notifyFailure: false });
      const sent = setup();
      const error = new DigestError('Ollama is not reachable');
      const record = failedRecord({ error: recordError({ error, step: 'write' }) });

      await endRun(held.ctx, { record, ...failure(error, 'write') }, undefined);
      await endRun(sent.ctx, { record, ...failure(error, 'write') }, undefined);

      expect(held.store.records.get(WEEK)).toEqual(sent.store.records.get(WEEK));
      expect(JSON.parse(held.store.artifacts.get(`${WEEK}/error.json`) ?? '{}')).toMatchObject({
        message: 'Ollama is not reachable',
      });
    });
  });
});

describe('needsForce', () => {
  it('knows the error of a resume that a person has to clear', () => {
    expect(needsForce('digest.md is gone; run with --force to send a new digest')).toBe(true);
  });

  it.each([
    ['an ordinary failure', 'Ollama is not reachable'],
    ['nothing', undefined],
    ['an empty message', ''],
  ])('does not take %s for one', (_name, message) => {
    expect(needsForce(message)).toBe(false);
  });
});

describe('isUnretriable', () => {
  it.each([
    [
      'a run told to stop before a step',
      'Run aborted before the write step: run timed out after 3 h',
    ],
    ['a run told to stop before the chain', 'Run aborted: the service was asked to stop again'],
    [
      'a resume that only --force can clear',
      'digest.md is gone; run with --force to send a new one',
    ],
  ])('knows %s', (_name, message) => {
    expect(isUnretriable(message)).toBe(true);
  });

  it('knows the message abortedError writes', () => {
    const controller = new AbortController();
    controller.abort(new Error('run timed out after 3 h'));

    expect(isUnretriable(abortedError(controller.signal, 'collect')?.message)).toBe(true);
    expect(isUnretriable(abortedError(controller.signal)?.message)).toBe(true);
  });

  it.each([
    ['an ordinary failure', 'Ollama is not reachable'],
    ['a message that only mentions aborting', 'The request was aborted by the server'],
    ['nothing', undefined],
  ])('does not take %s for one', (_name, message) => {
    expect(isUnretriable(message)).toBe(false);
  });
});

describe('sendHeldNote', () => {
  const heldRecord = (overrides: Partial<RunRecord> = {}): RunRecord =>
    failedRecord({ error: { message: 'Ollama is not reachable', step: 'write' }, ...overrides });

  it('sends the note the run would have sent, to every channel, once', async () => {
    const h = setup();

    await sendHeldNote({ deliveries: h.deliveries, logger: h.ctx.logger }, WEEK, heldRecord());

    expect(h.deliveries.map((delivery) => delivery.failures)).toEqual([
      [{ weekId: WEEK, step: 'write', message: 'Ollama is not reachable' }],
      [{ weekId: WEEK, step: 'write', message: 'Ollama is not reachable' }],
    ]);
  });

  it('is the same note endRun sends for that failure', async () => {
    const held = setup({ notifyFailure: false });
    const sent = setup();
    const error = new DigestError('Ollama is not reachable');
    const record = failedRecord({ error: recordError({ error, step: 'write' }) });

    await endRun(held.ctx, { record, ...failure(error, 'write') }, undefined);
    await sendHeldNote({ deliveries: held.deliveries, logger: held.ctx.logger }, WEEK, record);
    await endRun(sent.ctx, { record, ...failure(error, 'write') }, undefined);

    expect(held.deliveries.map((d) => d.failures)).toEqual(sent.deliveries.map((d) => d.failures));
  });

  it('names a failure that has no recorded error', async () => {
    const h = setup();
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
    const h = setup();
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
    const h = setup();

    await sendHeldNote(
      { deliveries: h.deliveries, logger: h.ctx.logger },
      WEEK,
      heldRecord({ dryRun: true }),
    );

    expect(notesOf(h)).toEqual([0, 0]);
  });
});
