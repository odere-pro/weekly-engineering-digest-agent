// A second run of a week that already has a digest: reuse, variant label, appendix, perspective.
import { describe, expect, it } from 'vitest';
import { WEEK, expectValidRecord, setup, weekItems } from './__fixtures__/runKit';
import { makeRunRecord } from '../../test/builders';
import type { RunOptions } from './types';

const TOPIC = 'zero-trust networking';

/**
 * A harness whose week already has a record, so a variant run needs `force`. A `sent` week keeps
 * its files when a dry run ends (the earlier record stays); a `dry-run` week takes the new ones.
 */
function sentWeek(scenario: Parameters<typeof setup>[0] = {}, status: 'sent' | 'dry-run' = 'sent') {
  const h = setup(scenario);
  h.store.records.set(WEEK, makeRunRecord({ runId: WEEK, status, sentUrls: [] }));
  return h;
}
const again = (extra: RunOptions): RunOptions => ({ force: true, dryRun: true, ...extra });

describe('runDigest with a variant', () => {
  it('complete: no fetch, the appendix in the message and not in digest.md', async () => {
    const items = weekItems(8);
    const h = sentWeek({ items }, 'dry-run');

    const result = await h.run(
      again({ reuse: { items, fetchSourceIds: [] }, variant: { kind: 'complete' } }),
    );

    expect(h.fetcher.calls).toHaveLength(0);
    expect(result.message?.variant).toBe('complete');
    expect(result.message?.subject).toContain('(complete)');
    expect(result.message?.markdown).toContain('## Everything this week');
    expect(result.message?.view?.appendix).toBeDefined();
    expect(h.artifact('digest.md')).not.toContain('Everything this week');
    expect(result.markdown).not.toContain('Everything this week');
    expect(result.record.variant).toEqual({ kind: 'complete' });
    expectValidRecord(result.record);
  });

  it('enrich: fetches the chosen source and merges with the saved items', async () => {
    const all = weekItems(6);
    const saved = all.slice(0, 4);
    // The feed still lists the saved releases next to the two new ones.
    const h = sentWeek({ items: [...all].reverse() }, 'dry-run');

    const result = await h.run(
      again({
        reuse: { items: saved, fetchSourceIds: ['example-feed'] },
        variant: { kind: 'enrich', keepUrls: saved.map((item) => item.url) },
      }),
    );

    expect(h.fetcher.calls).toHaveLength(1);
    const collected = JSON.parse(h.artifact('items.json') ?? '[]') as { url: string }[];
    const urls = collected.map((item) => item.url);
    expect(urls.slice(0, 4)).toEqual(saved.map((item) => item.url));
    expect([...urls].sort()).toEqual(all.map((item) => item.url).sort());
    expect(result.message?.variant).toBe('enriched');
    expect(result.message?.subject).toContain('(enriched)');
    expect(result.message?.markdown).not.toContain('Everything this week');
  });

  it('perspective: no fetch, the topic reaches the classify and write requests', async () => {
    const items = weekItems(5);
    const h = sentWeek({ items });

    const result = await h.run(
      again({
        reuse: { items, fetchSourceIds: [] },
        variant: { kind: 'perspective', topic: TOPIC },
      }),
    );

    expect(h.fetcher.calls).toHaveLength(0);
    expect(JSON.stringify(h.model.decideCalls)).toContain(TOPIC);
    expect(JSON.stringify(h.model.generateCalls)).toContain(TOPIC);
    expect(result.message?.variant).toBe('perspective-zero-trust-networking');
    expect(result.message?.view?.variant).toBe(`perspective: ${TOPIC}`);
    expect(result.record.variant).toEqual({ kind: 'perspective', topic: TOPIC });
  });

  it('a kept URL wins a relevance tie in the second digest', async () => {
    const items = weekItems(6);
    const kept = items[5]!;
    const h = sentWeek({ items, config: { topN: 3 } });

    const result = await h.run(
      again({
        reuse: { items, fetchSourceIds: [] },
        variant: { kind: 'enrich', keepUrls: [kept.url] },
      }),
    );

    expect(
      result.message?.view?.groups.flatMap((group) => group.items).map((item) => item.url),
    ).toContain(kept.url);
  });

  it('a run without a variant is unchanged: no label, no variant field', async () => {
    const h = setup();

    const result = await h.run({ dryRun: true });

    expect(result.message?.variant).toBeUndefined();
    expect(result.record).not.toHaveProperty('variant');
  });
});
