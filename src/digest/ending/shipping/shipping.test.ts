import { describe, expect, it } from 'vitest';
import { digestMessage } from './digestMessage';
import { forEachDelivery, shipDigest } from './shipping';
import { DigestError } from '../../../shared/errors';
import { buildDigestView } from '../../../render/layout';
import { renderDigest } from '../../../render/markdown';
import { makeDigest, makeDigestItem, makeItem } from '../../../../test/builders';
import { CapturingDelivery } from '../../../../test/fakes';
import { WEEK } from '../__fixtures__/endingKit';

const digest = {
  ...makeDigest([]),
  items: [
    makeDigestItem(makeItem(), { urgency: 'act-now', action: 'Upgrade.' }),
    makeDigestItem(makeItem(), { urgency: 'good-to-know' }),
  ],
};
const markdown = renderDigest(digest, { disabledGuards: [] });
const view = buildDigestView(digest, { disabledGuards: [] });

describe('forEachDelivery', () => {
  it('tries every channel and returns the ones that failed', async () => {
    const [markdown, email] = [new CapturingDelivery('markdown'), new CapturingDelivery('email')];
    email.failWith = new Error('SMTP 554');
    const message = { weekId: WEEK, subject: 'Digest', markdown: '# Digest\n' };

    const failures = await forEachDelivery([email, markdown], (d) => d.sendDigest(message));

    expect(failures).toEqual([{ id: 'email', error: 'SMTP 554' }]);
    expect(markdown.digests).toEqual([message]);
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

describe('shipDigest progress', () => {
  const message = { weekId: WEEK, subject: 'Digest', markdown: '# Digest\n' };

  it('reports, after each channel that took the digest, every channel that has it so far', async () => {
    const [email, slack] = [new CapturingDelivery('email'), new CapturingDelivery('slack')];
    email.failWith = new Error('SMTP 554');
    const reported: (readonly string[])[] = [];

    await shipDigest([email, slack], message, ['markdown'], (deliveredTo) => {
      reported.push(deliveredTo);
      return Promise.resolve();
    });

    expect(reported).toEqual([['markdown', 'slack']]);
  });

  it('reports a channel only once it has the digest, before the next one is tried', async () => {
    const [markdownFile, email] = [
      new CapturingDelivery('markdown'),
      new CapturingDelivery('email'),
    ];
    const order: string[] = [];
    const send = email.sendDigest.bind(email);
    email.sendDigest = (sent) => {
      order.push('email');
      return send(sent);
    };

    await shipDigest([markdownFile, email], message, [], (deliveredTo) => {
      order.push(`progress ${deliveredTo.join(',')}`);
      return Promise.resolve();
    });

    expect(order).toEqual(['progress markdown', 'email', 'progress markdown,email']);
  });
});

describe('shipDigest with a view', () => {
  it('hands the same message, view included, to every channel', async () => {
    const channels = [new CapturingDelivery('email'), new CapturingDelivery('slack')];
    const message = digestMessage(WEEK, digest.headline, markdown, view);

    await shipDigest(channels, message, []);

    expect(channels.map((channel) => channel.digests[0]?.view)).toEqual([view, view]);
  });
});
