import { describe, expect, it } from 'vitest';
import { makeItem, makeRunRecord } from '../builders';
import {
  CapturingDelivery,
  FakeInputGuard,
  FakeModelProvider,
  FakeOutputGuard,
  FakeSourceFetcher,
  MemoryRunStore,
  yesNoAnswers,
} from './index';

describe('test fakes', () => {
  it('MemoryRunStore follows the RunStore contract', async () => {
    const store = new MemoryRunStore();
    const lock = await store.acquireLock('2026-W42');
    await expect(store.acquireLock('2026-W42')).rejects.toThrow('in progress');
    await lock.release();
    expect(store.isLocked).toBe(false);

    await store.saveRunRecord(
      makeRunRecord({ runId: '2026-W40', sentUrls: ['https://a.example/1'] }),
    );
    await store.saveRunRecord(
      makeRunRecord({ runId: '2026-W41', status: 'failed', sentUrls: ['https://a.example/2'] }),
    );
    await store.saveRunRecord(makeRunRecord({ runId: '2026-W20' }));
    await store.saveArtifact('2026-W42', 'digest.md', '# hi');

    expect(await store.hasSentDigest('2026-W40')).toBe(true);
    expect(await store.hasSentDigest('2026-W41')).toBe(false);
    expect([...(await store.sentUrls('2026-W42', 4))]).toEqual(['https://a.example/1']);
    expect((await store.listRuns(2)).map((r) => r.runId)).toEqual(['2026-W41', '2026-W40']);
    expect(await store.getRunRecord('2026-W40')).toBeDefined();
    expect(await store.prune('2026-W42', 12)).toEqual(['2026-W20']);
    expect(store.artifacts.get('2026-W42/digest.md')).toBe('# hi');
  });

  it('MemoryRunStore dedupes the URLs of a partly delivered week like fsRunStore', async () => {
    const store = new MemoryRunStore();
    await store.saveRunRecord(
      makeRunRecord({
        runId: '2026-W41',
        status: 'failed',
        deliveredTo: ['markdown'],
        sentUrls: ['https://a.example/partial'],
      }),
    );
    await store.saveRunRecord(
      makeRunRecord({
        runId: '2026-W40',
        status: 'failed',
        deliveredTo: [],
        sentUrls: ['https://a.example/empty'],
      }),
    );
    await store.saveRunRecord(
      makeRunRecord({ runId: '2026-W39', status: 'failed', sentUrls: ['https://a.example/none'] }),
    );

    expect([...(await store.sentUrls('2026-W42', 4))]).toEqual(['https://a.example/partial']);
    expect(await store.hasSentDigest('2026-W41')).toBe(false);
  });

  it('fakes record calls and return scripted results', async () => {
    const model = new FakeModelProvider({
      generate: () => 'text',
      decide: (r) => yesNoAnswers(r, 0.9),
    });
    await model.generate({ role: 'write', system: 's', prompt: 'p' });
    const decided = await model.decide({
      role: 'guardPolicy',
      state: 's',
      questions: { q: { type: 'yesno', instructions: 'i' } },
    });
    expect(decided.answers.q).toEqual({ type: 'yesno', probability: 0.9 });
    expect((await model.health()).reachable).toBe(true);
    await expect(
      new FakeModelProvider().generate({ role: 'judge', system: '', prompt: '' }),
    ).rejects.toThrow();
    await expect(
      new FakeModelProvider().decide({ role: 'judge', state: '', questions: {} }),
    ).rejects.toThrow();

    const item = makeItem();
    expect((await new FakeInputGuard('clefPolicy', () => true).checkItem(item)).flagged).toBe(true);
    const draft = {
      writer: 'w',
      digest: { weekId: '2026-W42', headline: 'h', intro: 'i', items: [] },
    };
    expect((await new FakeOutputGuard('clefRubric').checkDraft(draft)).flagged).toBe(false);

    const fetcher = new FakeSourceFetcher('rss', { ok: [item], bad: new Error('down') });
    const window = { since: new Date(0), until: new Date(), maxItems: 5 };
    expect(await fetcher.fetch({ id: 'ok', kind: 'rss', url: 'https://e.com/f' }, window)).toEqual([
      item,
    ]);
    await expect(
      fetcher.fetch({ id: 'bad', kind: 'rss', url: 'https://e.com/f' }, window),
    ).rejects.toThrow('down');

    const delivery = new CapturingDelivery();
    await delivery.sendDigest({ weekId: 'w', subject: 's', markdown: 'm' });
    await delivery.sendFailure({ weekId: 'w', message: 'x' });
    delivery.failWith = new Error('smtp');
    await expect(delivery.sendDigest({ weekId: 'w', subject: 's', markdown: 'm' })).rejects.toThrow(
      'smtp',
    );
    expect(delivery.digests).toHaveLength(1);
    expect(delivery.failures).toHaveLength(1);
  });
});
