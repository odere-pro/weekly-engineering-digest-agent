// The collect window of a late run (a catch-up after downtime, a retry 30 minutes on) reaches back
// to where the last delivered run collected, so the items in between are not missed.
import { describe, expect, it, vi } from 'vitest';
import { setup } from './__fixtures__/runKit';
import { makeRunRecord } from '../../test/builders';

// The run starts at NOW, 2026-10-16T08:00Z, in week 2026-W42; the usual window is 7 days.
const USUAL_SINCE = new Date('2026-10-09T08:00:00Z');
const lastSent = makeRunRecord({
  runId: '2026-W40',
  status: 'sent',
  startedAt: '2026-10-05T07:00:00.000Z',
});

const since = (h: ReturnType<typeof setup>) => h.fetcher.calls[0]?.window.since;

describe('runDigest: the collect window of a late run', () => {
  it('starts where the last week that reached a channel collected', async () => {
    const h = setup();
    h.store.records.set(lastSent.runId, lastSent);
    const undelivered = makeRunRecord({
      runId: '2026-W41',
      status: 'failed',
      startedAt: '2026-10-12T07:00:00.000Z',
    });
    h.store.records.set(undelivered.runId, undelivered);

    await h.run();

    expect(since(h)).toEqual(new Date(lastSent.startedAt));
  });

  it('keeps an explicit window (--since) as it was asked for', async () => {
    const h = setup();
    h.store.records.set(lastSent.runId, lastSent);

    await h.run({ sinceDays: 3 });

    expect(since(h)).toEqual(new Date('2026-10-13T08:00:00Z'));
  });

  it('keeps the usual window, with a warning, when the earlier runs cannot be read', async () => {
    const h = setup();
    vi.spyOn(h.store, 'listRuns').mockRejectedValue(new Error('EIO'));

    const result = await h.run();

    expect(result.record.status).toBe('sent');
    expect(since(h)).toEqual(USUAL_SINCE);
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: 'Could not read the earlier runs; collecting over the usual window',
      }),
    );
  });

  it('keeps the usual window for a first run', async () => {
    const h = setup();

    await h.run();

    expect(since(h)).toEqual(USUAL_SINCE);
  });
});
