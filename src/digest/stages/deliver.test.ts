import { describe, expect, it } from 'vitest';
import { deliver } from './deliver';
import { PartialFailure } from '../chain/failures';
import { FALLBACK_NOTE } from '../../render/layout';
import { DigestError } from '../../shared/errors';
import { makeRunRecord } from '../../../test/builders';
import { CapturingDelivery } from '../../../test/fakes';
import { isUnretriable } from '../ending/notes/unretriable';
import {
  WEEK,
  WRITER_A,
  checkedDraft,
  contextFor,
  scored,
  stateOf,
} from '../__fixtures__/stageKit';

const items = [1, 2, 3].map((n) => scored(3, { title: `Runner ${n}.0 ships` }));
const winner = checkedDraft(items, WRITER_A);

const stateWith = (overrides = {}) => stateOf({ winner, selected: items, ...overrides });

describe('deliver', () => {
  it('fails without a winning draft: nothing to send', async () => {
    const h = contextFor();

    const failure = await deliver(h.ctx, stateOf(), h.logger).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DigestError);
    expect(failure).toMatchObject({
      step: 'deliver',
      message: 'Nothing to deliver: no winning draft',
    });
  });

  it('sends the same message to every channel and records the channels and the urls', async () => {
    const h = contextFor();

    const next = await deliver(h.ctx, stateWith(), h.logger);

    expect(next.deliveredTo).toEqual(['markdown', 'email']);
    expect(next.sentUrls).toEqual(winner.draft.digest.items.map((item) => item.url));
    const [markdown, email] = h.deliveries as CapturingDelivery[];
    expect(markdown?.digests).toHaveLength(1);
    expect(email?.digests).toEqual(markdown?.digests);
    expect(markdown?.digests[0]).toMatchObject({
      weekId: WEEK,
      subject: `Engineering digest ${WEEK}: ${winner.draft.digest.headline}`,
      markdown: winner.markdown,
    });
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        message: 'Digest delivered',
        fields: expect.objectContaining({ channels: ['markdown', 'email'] }) as object,
      }),
    );
  });

  it('names the guards that were off in the view footer', async () => {
    const h = contextFor({ disabledGuards: ['clefPolicy'] });

    await deliver(h.ctx, stateWith(), h.logger);

    const [markdown] = h.deliveries as CapturingDelivery[];
    expect(JSON.stringify(markdown?.digests[0]?.view)).toContain('clefPolicy');
  });

  it('marks the view of a template-only fallback', async () => {
    const h = contextFor();

    await deliver(h.ctx, stateWith({ fallback: true }), h.logger);

    const [markdown] = h.deliveries as CapturingDelivery[];
    expect(JSON.stringify(markdown?.digests[0]?.view)).toContain(FALLBACK_NOTE);
  });

  it('fails the step after trying every channel, keeping the one that took the digest', async () => {
    const email = new CapturingDelivery('email');
    email.failWith = new Error('SMTP 554');
    const markdown = new CapturingDelivery('markdown');
    const h = contextFor({ deliveries: [email, markdown] });

    const failure = await deliver(h.ctx, stateWith(), h.logger).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PartialFailure);
    const { state, cause } = failure as PartialFailure;
    expect(state.deliveredTo).toEqual(['markdown']);
    expect(state.sentUrls).toEqual(winner.draft.digest.items.map((item) => item.url));
    expect((cause as DigestError).message).toBe(
      'Delivery failed on email (SMTP 554); delivered on markdown',
    );
    expect(markdown.digests).toHaveLength(1);
  });

  it('counts no url as sent when no channel took the digest', async () => {
    const only = new CapturingDelivery('email');
    only.failWith = new Error('offline');
    const h = contextFor({ deliveries: [only] });

    const failure = await deliver(h.ctx, stateWith(), h.logger).catch((error: unknown) => error);

    const { state } = failure as PartialFailure;
    expect(state.deliveredTo).toEqual([]);
    expect(state.sentUrls).toEqual([]);
  });
});

describe('deliver when another run delivered the week while this one worked', () => {
  const sentByOther = makeRunRecord({
    runId: WEEK,
    status: 'sent',
    deliveredTo: ['markdown', 'email'],
  });
  const markdownOnly = makeRunRecord({ runId: WEEK, status: 'failed', deliveredTo: ['markdown'] });

  const abort = async (h: ReturnType<typeof contextFor>): Promise<DigestError> => {
    const failure = await deliver(h.ctx, stateWith(), h.logger).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DigestError);
    return failure as DigestError;
  };

  it('sends to no channel when the store holds a sent record this run did not start with', async () => {
    const h = contextFor();
    h.store.records.set(WEEK, sentByOther);

    const failure = await abort(h);

    expect(failure.step).toBe('deliver');
    expect(failure.message).toMatch(/^Run aborted before the deliver step: another run delivered/);
    expect(isUnretriable(failure.message)).toBe(true);
    for (const delivery of h.deliveries as CapturingDelivery[]) {
      expect(delivery.digests).toEqual([]);
    }
    expect(h.logs).toContainEqual(
      expect.objectContaining({ level: 'warn', message: 'Another run delivered this week' }),
    );
  });

  it('sends to no channel when another run reached a channel this run did not start with', async () => {
    const h = contextFor({ previousRecord: makeRunRecord({ runId: WEEK, status: 'failed' }) });
    h.store.records.set(WEEK, markdownOnly);

    const failure = await abort(h);

    expect(isUnretriable(failure.message)).toBe(true);
    for (const delivery of h.deliveries as CapturingDelivery[]) {
      expect(delivery.digests).toEqual([]);
    }
  });

  it('names no channel, address or digest text in the failure', async () => {
    const h = contextFor();
    h.store.records.set(WEEK, sentByOther);

    const failure = await abort(h);

    expect(failure.message).toBe(
      `Run aborted before the deliver step: another run delivered ${WEEK} while this one worked`,
    );
  });

  it.each<[string, ReturnType<typeof makeRunRecord>]>([
    ['a forced run over a sent week', sentByOther],
    ['a run over a partly delivered week', markdownOnly],
  ])('still delivers for %s: that record was there when the run began', async (_name, began) => {
    const h = contextFor({ previousRecord: began });
    h.store.records.set(WEEK, began);

    const next = await deliver(h.ctx, stateWith(), h.logger);

    expect(next.deliveredTo).toEqual(['markdown', 'email']);
  });

  it('delivers when the store holds no record of the week', async () => {
    const h = contextFor();

    const next = await deliver(h.ctx, stateWith(), h.logger);

    expect(next.deliveredTo).toEqual(['markdown', 'email']);
  });

  it('delivers when the record is a failed one that reached no channel', async () => {
    const h = contextFor();
    h.store.records.set(WEEK, makeRunRecord({ runId: WEEK, status: 'failed' }));

    const next = await deliver(h.ctx, stateWith(), h.logger);

    expect(next.deliveredTo).toEqual(['markdown', 'email']);
  });
});
