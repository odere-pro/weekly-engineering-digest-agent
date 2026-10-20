// A run killed in the middle of its delivery (SIGKILL, out of memory, power loss) leaves the
// record of the channels that had the digest, so the next run sends only to the rest.
import { describe, expect, it, vi } from 'vitest';
import { WEEK, sentDigests, setup } from './__fixtures__/runKit';

/** The run's process dies while the second channel sends: that send never returns. */
function killedAtSecondChannel(): ReturnType<typeof setup> {
  const killed = setup();
  const [, second] = killed.deliveries;
  if (!second) throw new Error('setup has two channels');
  second.sendDigest = () => new Promise<never>(() => undefined);
  void killed.run();
  return killed;
}

describe('runDigest killed while it delivers', () => {
  it('leaves a partly delivered week, and the next run sends only to the channel that lacks it', async () => {
    const killed = killedAtSecondChannel();
    await vi.waitFor(() => {
      expect(killed.store.records.get(WEEK)?.deliveredTo).toEqual(['markdown']);
    });

    // The next run finds the dead run's files: its own store starts with them.
    const next = setup();
    killed.store.records.forEach((record, week) => next.store.records.set(week, record));
    killed.store.artifacts.forEach((content, key) => next.store.artifacts.set(key, content));
    const result = await next.run();

    const [markdownFile, email] = next.deliveries;
    expect(markdownFile?.digests).toEqual([]);
    expect(email?.digests).toHaveLength(1);
    expect(sentDigests(next)).toHaveLength(1);
    expect(next.model.decideCalls).toEqual([]);
    expect(result.record).toMatchObject({ status: 'sent', deliveredTo: ['markdown', 'email'] });
  });
});
