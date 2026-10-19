import { describe, expect, it } from 'vitest';
import { withFallback } from './withFallback';
import { FALLBACK_NOTE } from '../../render/layout';
import { FALLBACK_WRITER } from '../../write/fallbackDigest';
import { makeDraft } from '../../../test/builders';
import { FakeModelProvider } from '../../../test/fakes';
import { WEEK, WRITER_A, contextFor, scored, stateOf } from '../__fixtures__/stageKit';

const selected = [1, 2, 3, 4].map((n) =>
  scored(3, { title: `Runner ${n}.0 ships`, summary: `Runner ${n}.0 is faster. It also caches.` }),
);
const rejectedState = () =>
  stateOf({
    selected,
    collected: selected,
    drafts: [{ writer: WRITER_A, passed: false, rejectedBy: ['linkCheck'] }],
  });

describe('withFallback', () => {
  it('is nothing when the fallback is off, and touches nothing', async () => {
    const h = contextFor({ useFallback: false });

    expect(await withFallback(h.ctx, rejectedState(), h.logger)).toBeUndefined();

    expect(h.store.artifacts.size).toBe(0);
    expect(h.logs).toEqual([]);
  });

  it('makes the template-only digest the only passing draft, with no model call', async () => {
    const model = new FakeModelProvider();
    const h = contextFor({ model });

    const next = await withFallback(h.ctx, rejectedState(), h.logger);

    expect(next?.fallback).toBe(true);
    expect(next?.passed.map((entry) => entry.draft.writer)).toEqual([FALLBACK_WRITER]);
    expect(next?.passed[0]?.draft.digest.items).toHaveLength(4);
    expect(next?.drafts.map((outcome) => outcome.writer)).toEqual([WRITER_A, FALLBACK_WRITER]);
    expect(next?.drafts.at(-1)).toMatchObject({ writer: FALLBACK_WRITER, passed: true });
    expect(model.generateCalls).toEqual([]);
    expect(model.decideCalls).toEqual([]);
    expect(JSON.stringify(next?.passed[0]?.markdown)).toContain(FALLBACK_NOTE);
  });

  it('adds the fallback draft to drafts.json, after the drafts the writers made', async () => {
    const h = contextFor();
    const earlier = makeDraft(selected, WRITER_A);
    const state = {
      ...rejectedState(),
      draftsFile: { drafts: [earlier], failures: [{ writer: 'w', error: 'x' }], rejections: [] },
    };

    await withFallback(h.ctx, state, h.logger);

    const file = JSON.parse(h.store.artifacts.get(`${WEEK}/drafts.json`) ?? '{}') as {
      drafts: { writer: string }[];
      failures: unknown[];
    };
    expect(file.drafts.map((draft) => draft.writer)).toEqual([WRITER_A, FALLBACK_WRITER]);
    expect(file.failures).toHaveLength(1);
  });

  it('writes drafts.json with just the fallback when the writers left none', async () => {
    const h = contextFor();

    await withFallback(h.ctx, rejectedState(), h.logger);

    const file = JSON.parse(h.store.artifacts.get(`${WEEK}/drafts.json`) ?? '{}') as {
      drafts: { writer: string }[];
      failures: unknown[];
      rejections: unknown[];
    };
    expect(file.drafts.map((draft) => draft.writer)).toEqual([FALLBACK_WRITER]);
    expect([file.failures, file.rejections]).toEqual([[], []]);
  });

  it('holds drafts.json when the earlier files of the week must stay', async () => {
    const h = contextFor({ holdArtifacts: true });

    const next = await withFallback(h.ctx, rejectedState(), h.logger);

    expect(h.store.artifacts.size).toBe(0);
    expect(next?.held.map((artifact) => artifact.name)).toEqual(['drafts.json']);
  });

  it('is nothing, and logs an error, when its own checks fail: too few items to make a digest', async () => {
    const h = contextFor();
    const state = stateOf({ selected: selected.slice(0, 2), collected: selected.slice(0, 2) });

    expect(await withFallback(h.ctx, state, h.logger)).toBeUndefined();

    expect(h.store.artifacts.size).toBe(0);
    expect(h.logs.some((line) => line.level === 'error')).toBe(true);
  });
});
