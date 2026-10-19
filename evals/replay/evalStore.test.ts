import { describe, expect, it } from 'vitest';
import { makeRunRecord } from '../../test/builders';
import { WEEK_40, WEEK_41 } from '../evalKit';
import { createEvalStore } from './evalStore';

describe('createEvalStore', () => {
  it('keeps run records and artifacts in memory and never reports a sent digest or sent urls', async () => {
    const store = createEvalStore();
    const lock = await store.acquireLock(WEEK_40);
    await store.saveArtifact(WEEK_40, 'digest.md', '# digest');
    await store.saveRunRecord(makeRunRecord({ runId: WEEK_40, status: 'dry-run' }));
    await store.saveRunRecord(makeRunRecord({ runId: WEEK_41, status: 'dry-run' }));

    expect(await store.getRunRecord(WEEK_40)).toMatchObject({ runId: WEEK_40 });
    expect(await store.getRunRecord('2026-W01')).toBeUndefined();
    expect(await store.hasSentDigest(WEEK_40)).toBe(false);
    expect((await store.listRuns()).map((r) => r.runId)).toEqual([WEEK_41, WEEK_40]);
    expect(await store.listRuns(1)).toHaveLength(1);
    expect(await store.sentUrls(WEEK_41, 4)).toEqual(new Set());
    expect(await store.prune(WEEK_41, 1)).toEqual([]);
    await expect(lock.release()).resolves.toBeUndefined();
  });

  it('reports a sent run as sent', async () => {
    const store = createEvalStore();
    await store.saveRunRecord(makeRunRecord({ runId: WEEK_40, status: 'sent' }));
    expect(await store.hasSentDigest(WEEK_40)).toBe(true);
  });

  it('reads back an artifact it saved, per run', async () => {
    const store = createEvalStore();
    await store.saveArtifact(WEEK_40, 'digest.md', '# forty');
    await store.saveArtifact(WEEK_41, 'digest.md', '# forty-one');

    expect(await store.readArtifact(WEEK_40, 'digest.md')).toBe('# forty');
    expect(await store.readArtifact(WEEK_41, 'digest.md')).toBe('# forty-one');
    expect(await store.readArtifact(WEEK_40, 'review.md')).toBeUndefined();
  });

  it('shares nothing between two stores', async () => {
    const first = createEvalStore();
    const second = createEvalStore();
    await first.saveRunRecord(makeRunRecord({ runId: WEEK_40 }));

    expect(await second.getRunRecord(WEEK_40)).toBeUndefined();
  });
});
