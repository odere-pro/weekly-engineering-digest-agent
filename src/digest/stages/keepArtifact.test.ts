import { describe, expect, it } from 'vitest';
import { keepArtifact } from './keepArtifact';
import { WEEK, contextFor, lostLock, stateOf } from '../__fixtures__/stageKit';

describe('keepArtifact', () => {
  it('writes the file now and hands the state back as it is', async () => {
    const h = contextFor();
    const state = stateOf();

    const next = await keepArtifact(h.ctx, state, 'items.json', '[]\n');

    expect(next).toBe(state);
    expect(h.store.artifacts.get(`${WEEK}/items.json`)).toBe('[]\n');
  });

  it('holds the file in the state, writing nothing, when the week files must stay', async () => {
    const h = contextFor({ holdArtifacts: true });
    const state = stateOf({ held: [{ name: 'items.json', content: '[]\n' }] });

    const next = await keepArtifact(h.ctx, state, 'scores.json', '[1]\n');

    expect(next.held).toEqual([
      { name: 'items.json', content: '[]\n' },
      { name: 'scores.json', content: '[1]\n' },
    ]);
    expect(state.held).toHaveLength(1);
    expect(h.store.artifacts.size).toBe(0);
  });

  it('writes nothing once the run lost its lock: the week folder belongs to the other run', async () => {
    const h = contextFor({ lockLost: lostLock() });

    const failure = keepArtifact(h.ctx, stateOf(), 'scores.json', '[]\n');

    await expect(failure).rejects.toThrow(/^Run aborted: this run lost its lock/);
    expect(h.store.artifacts.size).toBe(0);
  });

  it('lets the store error through when a write fails: a stage cannot go on without its file', async () => {
    const h = contextFor();
    h.store.saveArtifact = () => Promise.reject(new Error('disk full'));

    await expect(keepArtifact(h.ctx, stateOf(), 'items.json', '[]\n')).rejects.toThrow('disk full');
  });
});
