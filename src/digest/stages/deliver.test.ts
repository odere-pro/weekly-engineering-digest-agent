import { describe, expect, it } from 'vitest';
import { deliver } from './deliver';
import { PartialFailure } from '../chain/failures';
import { FALLBACK_NOTE } from '../../render/layout';
import { DigestError } from '../../shared/errors';
import { CapturingDelivery } from '../../../test/fakes';
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
