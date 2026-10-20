import { describe, expect, it } from 'vitest';
import type { AppHandle } from '../../../app/container';
import type { Delivery } from '../../../delivery/Delivery';
import { makeRunRecord } from '../../../../test/builders';
import { CapturingDelivery } from '../../../../test/fakes';
import { scriptedPrompts } from '../../init/__fixtures__/initHarness';
import { harness, variantResult } from '../__fixtures__/runHarness';
import { confirmSend, sendChannelIds, sendVariant } from './sendConfirm';

const WEEK = '2026-W43';
const variant = { kind: 'complete', keepUrls: [] } as const;

function appWith(deliveries: readonly Delivery[], status: 'sent' | 'dry-run' = 'dry-run') {
  const h = harness(undefined, { deliveries });
  h.store.records.set(
    WEEK,
    makeRunRecord({
      runId: WEEK,
      status,
      sentUrls: ['https://example.com/old'],
      deliveredTo: ['markdown'],
    }),
  );
  const app: AppHandle = { deps: h.appDeps, close: () => Promise.resolve() };
  return { app, store: h.store };
}

describe('confirmSend', () => {
  it('asks "Send to <ids>?" and defaults to no', async () => {
    const { prompts, calls } = scriptedPrompts();

    expect(await confirmSend(prompts, ['email', 'slack'])).toBe(false);
    expect(calls[0]?.message).toBe('Send to email, slack?');
    expect(calls[0]?.options.default).toBe(false);
  });

  it('returns the answer', async () => {
    const { prompts } = scriptedPrompts([[/Send to/, true]]);

    expect(await confirmSend(prompts, ['email'])).toBe(true);
  });

  it('does not ask when only the Markdown file exists', async () => {
    const { prompts, calls } = scriptedPrompts();

    expect(await confirmSend(prompts, [])).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('sendChannelIds', () => {
  it('lists the configured channels but the Markdown file', () => {
    const { app } = appWith([
      new CapturingDelivery('markdown'),
      new CapturingDelivery('email'),
      new CapturingDelivery('slack'),
    ]);

    expect(sendChannelIds(app)).toEqual(['email', 'slack']);
  });
});

describe('sendVariant', () => {
  const message = variantResult('complete', [
    'https://example.com/a',
    'https://example.com/b',
  ]).message!;

  it('ships to the non-Markdown channels and marks a dry-run week sent', async () => {
    const markdown = new CapturingDelivery('markdown');
    const email = new CapturingDelivery('email');
    const { app, store } = appWith([markdown, email]);

    const sent = await sendVariant(app, message, variant, WEEK);

    expect(sent.error).toBeUndefined();
    expect(email.digests).toEqual([message]);
    expect(markdown.digests).toEqual([]);
    expect(store.records.get(WEEK)).toMatchObject({
      status: 'sent',
      deliveredTo: ['markdown', 'email'],
      sentUrls: ['https://example.com/a', 'https://example.com/b'],
      variant: { kind: 'complete' },
    });
  });

  it('keeps a sent week sent and adds the URLs to the old ones', async () => {
    const email = new CapturingDelivery('email');
    const { app, store } = appWith([email], 'sent');

    await sendVariant(app, message, variant, WEEK);

    expect(store.records.get(WEEK)?.sentUrls).toEqual([
      'https://example.com/old',
      'https://example.com/a',
      'https://example.com/b',
    ]);
  });

  it('reads the URLs from the Markdown when the message has no view', async () => {
    const email = new CapturingDelivery('email');
    const { app, store } = appWith([email]);

    await sendVariant(app, { ...message, view: undefined }, variant, WEEK);

    expect(store.records.get(WEEK)?.sentUrls).toEqual([
      'https://example.com/a',
      'https://example.com/b',
    ]);
  });

  it('marks the channels that took it and names the one that failed', async () => {
    const email = new CapturingDelivery('email');
    email.failWith = new Error('smtp down');
    const slack = new CapturingDelivery('slack');
    const { app, store } = appWith([email, slack]);

    const sent = await sendVariant(app, message, variant, WEEK);

    expect(sent.error?.message).toMatch(/email \(smtp down\)/);
    expect(sent.deliveredTo).toEqual(['markdown', 'slack']);
    expect(store.records.get(WEEK)?.deliveredTo).toEqual(['markdown', 'slack']);
  });

  it('leaves the record alone when no channel took it', async () => {
    const email = new CapturingDelivery('email');
    email.failWith = new Error('smtp down');
    const { app, store } = appWith([email]);

    const sent = await sendVariant(app, message, variant, WEEK);

    expect(sent.error).toBeDefined();
    expect(store.records.get(WEEK)?.status).toBe('dry-run');
  });

  it('reports a record that cannot be updated, after the digest went out', async () => {
    const email = new CapturingDelivery('email');
    const { app, store } = appWith([email]);
    store.records.delete(WEEK);

    const sent = await sendVariant(app, message, variant, WEEK);

    expect(email.digests).toHaveLength(1);
    expect(sent.deliveredTo).toEqual(['markdown', 'email']);
    expect(sent.error?.message).toMatch(/record could not be updated/);
  });
});
