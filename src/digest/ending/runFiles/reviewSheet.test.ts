import { describe, expect, it, vi } from 'vitest';
import { writeReviewSheet } from './reviewSheet';
import type { HeldArtifact } from '../types';
import type { MemoryRunStore } from '../../../../test/fakes';
import { makeClassification, makeDraft, makeItem } from '../../../../test/builders';
import { WEEK, record, setupEnding } from '../__fixtures__/endingKit';

describe('writeReviewSheet', () => {
  const items = [1, 2, 3].map((n) =>
    makeItem({ id: `r${n}`, title: `Release ${n}`, url: `https://example.com/r/${n}` }),
  );
  const files: readonly HeldArtifact[] = [
    { name: 'items.json', content: JSON.stringify(items) },
    { name: 'scores.json', content: JSON.stringify(items.map((i) => makeClassification(i.id))) },
    { name: 'drafts.json', content: JSON.stringify({ drafts: [makeDraft([items[0]!], 'w1')] }) },
  ];
  const withWinner = record({ status: 'dry-run', winner: 'w1' });
  const reviewOf = (store: MemoryRunStore): string | undefined =>
    store.artifacts.get(`${WEEK}/review.md`);

  it('writes review.md from the held files of a run that reached the write step', async () => {
    const h = setupEnding({ dryRun: true });

    await writeReviewSheet(h.ctx, withWinner, files);

    const sheet = reviewOf(h.store);
    expect(sheet).toContain('## Picked\n\n- [ ] `r1` | rank 1');
    expect(sheet).toContain('## Candidates\n\n- [ ] `r2` | rank 2');
  });

  it('reads the files from the store when the run already wrote them', async () => {
    const h = setupEnding();
    for (const { name, content } of files) await h.store.saveArtifact(WEEK, name, content);

    await writeReviewSheet(h.ctx, record({ status: 'sent', winner: 'w1' }), []);

    expect(reviewOf(h.store)).toContain('`r1`');
  });

  it('prefers the last held file of a name over the one in the store', async () => {
    const h = setupEnding();
    await h.store.saveArtifact(WEEK, 'items.json', 'not json');
    const newer = [{ name: 'items.json', content: JSON.stringify(items.slice(0, 2)) } as const];

    await writeReviewSheet(h.ctx, withWinner, [...files, ...newer]);

    expect(reviewOf(h.store)).toContain('`r1`');
    expect(reviewOf(h.store)).not.toContain('`r3`');
  });

  it.each([
    ['no winner', record({ status: 'blocked', winner: null })],
    ['a winner no draft has', record({ status: 'sent', winner: 'other-writer' })],
  ])('writes no sheet for %s', async (_name, ended) => {
    const h = setupEnding();

    await writeReviewSheet(h.ctx, ended, files);

    expect(reviewOf(h.store)).toBeUndefined();
  });

  it('logs and goes on when a file is missing or broken', async () => {
    const h = setupEnding();
    const broken = [{ name: 'items.json', content: 'not json' } as const];

    await expect(writeReviewSheet(h.ctx, withWinner, broken)).resolves.toBeUndefined();
    await expect(writeReviewSheet(h.ctx, withWinner, [])).resolves.toBeUndefined();

    expect(reviewOf(h.store)).toBeUndefined();
    const warned = h.logs.filter((l) => l.level === 'warn' && l.message.includes('review sheet'));
    expect(warned).toHaveLength(2);
  });

  it('logs and goes on when the sheet cannot be written', async () => {
    const h = setupEnding();
    const save = h.store.saveArtifact.bind(h.store);
    vi.spyOn(h.store, 'saveArtifact').mockImplementation((id, name, content) =>
      name === 'review.md' ? Promise.reject(new Error('disk full')) : save(id, name, content),
    );

    await writeReviewSheet(h.ctx, withWinner, files);

    expect(h.logs.some((l) => l.level === 'error' && l.message.includes('review.md'))).toBe(true);
  });
});
