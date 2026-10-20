import { describe, expect, it, vi } from 'vitest';
import { DELIVERY_CUT_OFF, saveProgress } from './saveProgress';
import { WEEK, partly, record, sent, setupEnding } from './__fixtures__/endingKit';

const progress = record({
  status: 'failed',
  deliveredTo: ['markdown'],
  error: { step: 'deliver', message: DELIVERY_CUT_OFF },
});
const held = [{ name: 'digest.md' as const, content: '# New\n' }];

describe('saveProgress', () => {
  it('saves the record of the delivery so far, with the files the run held', async () => {
    const h = setupEnding();

    await saveProgress(h.ctx, progress, undefined, held);

    expect(h.store.records.get(WEEK)).toBe(progress);
    expect(h.store.artifacts.get(`${WEEK}/digest.md`)).toBe('# New\n');
  });

  it('replaces its own earlier progress as more channels take the digest', async () => {
    const h = setupEnding();
    const further = { ...progress, deliveredTo: ['markdown' as const, 'email' as const] };

    await saveProgress(h.ctx, progress, undefined);
    await saveProgress(h.ctx, further, undefined);

    expect(h.store.records.get(WEEK)).toBe(further);
  });

  it('leaves a record that must stay: a forced run never makes a sent week look unsent', async () => {
    const h = setupEnding();
    h.store.records.set(WEEK, sent);

    await saveProgress(h.ctx, progress, sent, held);

    expect(h.store.records.get(WEEK)).toBe(sent);
    expect(h.store.artifacts.size).toBe(0);
  });

  it('saves over a partly delivered week once this run reached a channel too', async () => {
    const h = setupEnding();
    h.store.records.set(WEEK, partly);

    await saveProgress(h.ctx, progress, partly);

    expect(h.store.records.get(WEEK)).toBe(progress);
  });

  it('logs and goes on when the store fails: the channel took the digest either way', async () => {
    const h = setupEnding();
    vi.spyOn(h.store, 'saveRunRecord').mockRejectedValue(new Error('disk full'));

    await expect(saveProgress(h.ctx, progress, undefined)).resolves.toBeUndefined();

    expect(h.logs).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: 'Could not save the delivery progress',
        fields: { error: 'disk full' },
      }),
    );
  });
});
