// A run that stalled past the heartbeat timeout lost its lock; another run took it over and sent
// the week. When the first run wakes it must not send a second copy or replace the sent record.
import { describe, expect, it } from 'vitest';
import { runDigest } from './runDigest';
import { KEPT_OTHER_RUN_REASON } from './ending/keepReason';
import { isUnretriable } from './ending/notes/unretriable';
import { WEEK, sentDigests, sentNotes, setup } from './__fixtures__/runKit';
import { ExitCode } from '../domain/schemas';
import type { DigestDeps, RunOptions } from './types';
import { makeRunRecord } from '../../test/builders';

/** Run A, parked in its first model call while `meanwhile` happens, as a frozen process is. */
async function runStalled(
  h: ReturnType<typeof setup>,
  meanwhile: () => void,
  options: RunOptions = {},
) {
  let wake!: () => void;
  const parked = new Promise<void>((resolve) => (wake = resolve));
  let reached!: () => void;
  const reachedGate = new Promise<void>((resolve) => (reached = resolve));
  let first = true;
  const model: DigestDeps['model'] = {
    health: () => h.model.health(),
    generate: (request) => h.model.generate(request),
    decide: async (request) => {
      if (first) {
        first = false;
        reached();
        await parked;
      }
      return h.model.decide(request);
    },
  };
  const pending = runDigest({ ...h.deps, model }, options);
  await reachedGate;
  meanwhile();
  wake();
  return pending;
}

const otherRunSent = makeRunRecord({
  runId: WEEK,
  status: 'sent',
  deliveredTo: ['markdown', 'email'],
  sentUrls: ['https://example.com/other-run'],
  winner: 'the-other-run-writer',
});

describe('runDigest: the lock was lost to a run that delivered the week', () => {
  it('sends nothing and leaves the record of the run that sent the week', async () => {
    const h = setup();

    const result = await runStalled(h, () => h.store.records.set(WEEK, otherRunSent));

    expect(sentDigests(h)).toEqual([]);
    expect(h.store.records.get(WEEK)).toBe(otherRunSent);
    expect(result.exitCode).toBe(ExitCode.Failed);
    expect(result.kept).toBe(KEPT_OTHER_RUN_REASON);
    expect(result.record).toMatchObject({ status: 'failed', error: { step: 'deliver' } });
    expect(result.record.error?.message).toMatch(
      /^Run aborted before the deliver step: another run/,
    );
  });

  it('does not write its error.json over the files of the run that sent the week', async () => {
    const h = setup();
    h.store.artifacts.set(`${WEEK}/error.json`, '{"from":"nobody"}');

    await runStalled(h, () => h.store.records.set(WEEK, otherRunSent));

    expect(h.artifact('error.json')).toBe('{"from":"nobody"}');
  });

  it('still reports it, even to a caller that holds notes back for a retry', async () => {
    const h = setup();

    const result = await runStalled(h, () => h.store.records.set(WEEK, otherRunSent), {
      notifyFailure: false,
    });

    expect(isUnretriable(result.record.error?.message)).toBe(true);
    expect(sentNotes(h).map((note) => note.step)).toEqual(['deliver', 'deliver']);
  });

  it('delivers as usual when no other run delivered the week meanwhile', async () => {
    const h = setup();

    const result = await runStalled(h, () => undefined);

    expect(result.record.status).toBe('sent');
    expect(sentDigests(h)).toHaveLength(2);
    expect(result.kept).toBeUndefined();
  });

  it('keeps a quiet run from replacing the sent record, too', async () => {
    const h = setup({ relevance: () => 0 });

    const result = await runStalled(h, () => h.store.records.set(WEEK, otherRunSent));

    expect(result.record.status).toBe('quiet');
    expect(result.kept).toBe(KEPT_OTHER_RUN_REASON);
    expect(h.store.records.get(WEEK)).toBe(otherRunSent);
  });
});
