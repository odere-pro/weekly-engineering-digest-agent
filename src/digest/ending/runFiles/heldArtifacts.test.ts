import { describe, expect, it, vi } from 'vitest';
import { writeHeld } from './heldArtifacts';
import type { HeldArtifact } from '../types';
import { WEEK, setupEnding } from '../__fixtures__/endingKit';

const held: readonly HeldArtifact[] = [
  { name: 'items.json', content: '[]\n' },
  { name: 'digest.md', content: '# Digest\n' },
];

describe('writeHeld', () => {
  it('writes every artifact and names the ones it wrote', async () => {
    const h = setupEnding();

    const written = await writeHeld(h.ctx, held);

    expect(written).toEqual(new Set(['items.json', 'digest.md']));
    expect(h.store.artifacts.get(`${WEEK}/digest.md`)).toBe('# Digest\n');
    expect(h.logs).toEqual([]);
  });

  it('lets a later artifact of the same name replace an earlier one', async () => {
    const h = setupEnding();

    await writeHeld(h.ctx, [...held, { name: 'digest.md', content: '# Newer\n' }]);

    expect(h.store.artifacts.get(`${WEEK}/digest.md`)).toBe('# Newer\n');
  });

  it('logs a file it cannot write, leaves it out of the result and writes the rest', async () => {
    const h = setupEnding();
    const save = h.store.saveArtifact.bind(h.store);
    vi.spyOn(h.store, 'saveArtifact').mockImplementation((runId, name, content) =>
      name === 'items.json' ? Promise.reject(new Error('EROFS')) : save(runId, name, content),
    );

    const written = await writeHeld(h.ctx, held);

    expect(written).toEqual(new Set(['digest.md']));
    expect(h.logs).toEqual([
      { level: 'error', message: 'Could not write items.json', fields: { error: 'EROFS' } },
    ]);
  });

  it('has nothing to write for no artifacts', async () => {
    const h = setupEnding();

    expect(await writeHeld(h.ctx, [])).toEqual(new Set());
  });
});
