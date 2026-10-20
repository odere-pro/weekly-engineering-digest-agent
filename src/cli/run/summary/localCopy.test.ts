import { describe, expect, it } from 'vitest';
import type { AppHandle } from '../../../app/container';
import type { Delivery } from '../../../delivery/Delivery';
import { CapturingDelivery } from '../../../../test/fakes';
import { harness } from '../__fixtures__/runHarness';
import { saveLocalCopy } from './localCopy';

const message = { weekId: '2026-W43', subject: 'Digest', markdown: '# Digest\n' };

function appWith(...deliveries: Delivery[]): AppHandle {
  const { appDeps } = harness(undefined, { deliveries });
  return { deps: appDeps, close: () => Promise.resolve() };
}

describe('saveLocalCopy', () => {
  it('gives the message to the markdown channel only', async () => {
    const markdown = new CapturingDelivery('markdown');
    const email = new CapturingDelivery('email');

    const copy = await saveLocalCopy(appWith(email, markdown), message);

    expect(copy).toEqual({ written: true });
    expect(markdown.digests).toEqual([message]);
    expect(email.digests).toEqual([]);
  });

  it('writes nothing without a markdown channel', async () => {
    const email = new CapturingDelivery('email');

    expect(await saveLocalCopy(appWith(email), message)).toEqual({ written: false });
    expect(email.digests).toEqual([]);
  });

  it('reports a failed write instead of throwing', async () => {
    const failing = new CapturingDelivery('markdown');
    failing.failWith = new Error('disk full');

    expect(await saveLocalCopy(appWith(failing), message)).toEqual({
      written: false,
      error: 'disk full',
    });
  });
});
