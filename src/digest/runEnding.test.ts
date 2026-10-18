import { describe, expect, it, vi } from 'vitest';
import {
  abortedError,
  digestMessage,
  endRun,
  failureNote,
  forEachDelivery,
  reachedAChannel,
  recordError,
  shipDigest,
  type EndingContext,
  type HeldArtifact,
} from './runEnding';
import type { RunRecord } from '../store/runRecord';
import { DigestError } from '../shared/errors';
import type { LogFields, Logger } from '../shared/telemetry';
import { makeClassification, makeDraft, makeItem, makeRunRecord } from '../../test/builders';
import { CapturingDelivery, MemoryRunStore } from '../../test/fakes';

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
    const h = setup();
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
const sent = record({ status: 'sent' });
const writtenFiles = (store: MemoryRunStore): string[] => [...store.artifacts.keys()].sort();

describe('endRun: artifacts held for the record', () => {
  it('writes them once the record is saved, and says which', async () => {
    const h = setup();
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
    const h = setup();
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
    const h = setup();
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
    const h = setup();
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
    const h = setup();
    vi.spyOn(h.store, 'saveRunRecord').mockRejectedValue(new Error('disk full'));

    await expect(endRun(h.ctx, { record: sent, artifacts: held }, undefined)).rejects.toThrow(
      DigestError,
    );

    expect(writtenFiles(h.store)).toEqual([]);
  });

  it('has nothing to write when the run held no artifacts', async () => {
    const h = setup();

    const { written } = await endRun(h.ctx, { record: sent }, undefined);

    expect(written).toEqual(new Set());
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
  it.each<[string, RunRecord | undefined, boolean]>([
    ['no record', undefined, false],
    ['a failed record that reached no channel', record({ status: 'failed' }), false],
    ['a sent record', record({ status: 'sent' }), true],
    ['a partly delivered record', partly, true],
  ])('says whether %s reached a channel', (_name, given, expected) => {
    expect(reachedAChannel(given)).toBe(expected);
  });

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

describe('digestMessage', () => {
  it('names the week and the headline in the subject', () => {
    expect(digestMessage(WEEK, 'Runners moved', '# Runners moved\n')).toEqual({
      weekId: WEEK,
      subject: `Engineering digest ${WEEK}: Runners moved`,
      markdown: '# Runners moved\n',
    });
  });

  it('puts a multi-line headline on one line', () => {
    expect(digestMessage(WEEK, '  Runners\n  moved \t today ', '#').subject).toBe(
      `Engineering digest ${WEEK}: Runners moved today`,
    );
  });

  it('leaves the headline out when it is empty', () => {
    expect(digestMessage(WEEK, ' \n ', '#').subject).toBe(`Engineering digest ${WEEK}`);
  });

  it('cuts a long subject, ending it with an ellipsis', () => {
    const { subject } = digestMessage(WEEK, 'word '.repeat(100), '#');

    expect(subject.length).toBeLessThanOrEqual(120);
    expect(subject.endsWith('...')).toBe(true);
  });
});

describe('shipDigest', () => {
  const message = { weekId: WEEK, subject: 'Digest', markdown: '# Digest\n' };

  it('sends to every channel and lists them after the ones that already had the digest', async () => {
    const channels = [new CapturingDelivery('email'), new CapturingDelivery('slack')];

    const shipped = await shipDigest(channels, message, ['markdown']);

    expect(shipped).toEqual({ deliveredTo: ['markdown', 'email', 'slack'] });
    expect(channels.map((channel) => channel.digests)).toEqual([[message], [message]]);
  });

  it('keeps going after a failed channel and names both outcomes in the error', async () => {
    const [email, slack] = [new CapturingDelivery('email'), new CapturingDelivery('slack')];
    email.failWith = new Error('SMTP 554');

    const shipped = await shipDigest([email, slack], message, ['markdown']);

    expect(shipped.deliveredTo).toEqual(['markdown', 'slack']);
    expect(shipped.error).toBeInstanceOf(DigestError);
    expect(shipped.error?.message).toBe(
      'Delivery failed on email (SMTP 554); delivered on markdown, slack',
    );
    expect(shipped.error).toMatchObject({ step: 'deliver' });
  });

  it('omits the delivered part when no channel got the digest', async () => {
    const channel = new CapturingDelivery('email');
    channel.failWith = new Error('offline');

    const shipped = await shipDigest([channel], message, []);

    expect(shipped.deliveredTo).toEqual([]);
    expect(shipped.error?.message).toBe('Delivery failed on email (offline)');
  });

  it('does not change the list it was given', async () => {
    const already = Object.freeze(['markdown' as const]);

    const shipped = await shipDigest([new CapturingDelivery('email')], message, already);

    expect(already).toEqual(['markdown']);
    expect(shipped.deliveredTo).toEqual(['markdown', 'email']);
  });
});

describe('abortedError', () => {
  it('is nothing for no signal or a signal that has not fired', () => {
    expect(abortedError(undefined, 'write')).toBeUndefined();
    expect(abortedError(new AbortController().signal, 'write')).toBeUndefined();
  });

  it('names the step the run was about to start and the reason', () => {
    const controller = new AbortController();
    controller.abort(new Error('scheduler timeout after 2h'));

    const error = abortedError(controller.signal, 'write');

    expect(error).toBeInstanceOf(DigestError);
    expect(error?.message).toBe('Run aborted before the write step: scheduler timeout after 2h');
    expect(error?.step).toBe('write');
    expect(error?.cause).toBe(controller.signal.reason);
  });

  it('leaves the step out when the run had not started one', () => {
    const controller = new AbortController();
    controller.abort('shutting down');

    const error = abortedError(controller.signal);

    expect(error?.message).toBe('Run aborted: shutting down');
    expect(error?.step).toBeUndefined();
  });

  it('exits like any failed run', () => {
    const controller = new AbortController();
    controller.abort();

    expect(abortedError(controller.signal)?.exitCode).toBe(1);
  });
});

describe('endRun: review sheet', () => {
  const items = [1, 2, 3].map((n) =>
    makeItem({ id: `r${n}`, title: `Release ${n}`, url: `https://example.com/r/${n}` }),
  );
  const files: readonly HeldArtifact[] = [
    { name: 'items.json', content: JSON.stringify(items) },
    { name: 'scores.json', content: JSON.stringify(items.map((i) => makeClassification(i.id))) },
    { name: 'drafts.json', content: JSON.stringify({ drafts: [makeDraft([items[0]!], 'w1')] }) },
  ];
  const withWinner = record({ status: 'dry-run', winner: 'w1' });
  const reviewOf = (store: MemoryRunStore): string | undefined =>
    store.artifacts.get(`${WEEK}/review.md`);

  it('writes review.md from the held files of a run that reached the write step', async () => {
    const h = setup(true);

    await endRun(h.ctx, { record: withWinner, artifacts: files }, undefined);

    const sheet = reviewOf(h.store);
    expect(sheet).toContain('## Picked\n\n- [ ] `r1` | rank 1');
    expect(sheet).toContain('## Candidates\n\n- [ ] `r2` | rank 2');
  });

  it('reads the files from the store when the run already wrote them', async () => {
    const h = setup();
    for (const { name, content } of files) await h.store.saveArtifact(WEEK, name, content);

    await endRun(h.ctx, { record: record({ status: 'sent', winner: 'w1' }) }, undefined);

    expect(reviewOf(h.store)).toContain('`r1`');
  });

  it.each([
    ['no winner', record({ status: 'blocked', winner: null })],
    ['a winner no draft has', record({ status: 'sent', winner: 'other-writer' })],
  ])('writes no sheet for %s', async (_name, ended) => {
    const h = setup();

    await endRun(h.ctx, { record: ended, artifacts: files }, undefined);

    expect(reviewOf(h.store)).toBeUndefined();
  });

  it('writes no sheet when the earlier record stayed', async () => {
    const h = setup();
    h.store.records.set(WEEK, sent);

    await endRun(h.ctx, { record: withWinner, artifacts: files }, sent);

    expect(reviewOf(h.store)).toBeUndefined();
  });

  it('logs and goes on when a file is missing or broken', async () => {
    const h = setup();
    const broken = [{ name: 'items.json', content: 'not json' } as const];

    await expect(
      endRun(h.ctx, { record: withWinner, artifacts: broken }, undefined),
    ).resolves.toBeDefined();

    expect(reviewOf(h.store)).toBeUndefined();
    expect(h.logs.some((l) => l.level === 'warn' && l.message.includes('review sheet'))).toBe(true);
  });

  it('logs and goes on when the sheet cannot be written', async () => {
    const h = setup();
    const save = h.store.saveArtifact.bind(h.store);
    vi.spyOn(h.store, 'saveArtifact').mockImplementation((id, name, content) =>
      name === 'review.md' ? Promise.reject(new Error('disk full')) : save(id, name, content),
    );

    await endRun(h.ctx, { record: withWinner, artifacts: files }, undefined);

    expect(h.logs.some((l) => l.level === 'error' && l.message.includes('review.md'))).toBe(true);
  });
});
