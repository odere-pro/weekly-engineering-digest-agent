import { describe, expect, it } from 'vitest';
import type { ScoredItem } from '../../classify/classification';
import type { GuardCallOptions, InputGuard } from '../../guards/Guard';
import { makeRunRecord } from '../../../test/builders';
import { FakeInputGuard } from '../../../test/fakes';
import { contextFor, scored, stateOf } from '../__fixtures__/stageKit';
import { guardCandidates } from './guardCandidates';

/** Six items, best first: Release 0 to Release 5, all in one area and over every threshold. */
const SCORED: readonly ScoredItem[] = [3, 2.9, 2.8, 2.7, 2.6, 2.5].map((relevance, index) =>
  scored(relevance, { title: `Release ${index}`, url: `https://example.com/release-${index}` }),
);
const titles = (items: readonly { title: string }[]): string[] => items.map((item) => item.title);
const titled =
  (...wanted: string[]) =>
  (item: { title: string }): boolean =>
    wanted.includes(item.title);

function guards(flag: (item: { title: string }) => boolean = () => false) {
  return {
    rule: new FakeInputGuard('ruleInjection', () => true),
    clef: new FakeInputGuard('clefPolicy', flag),
    granite: new FakeInputGuard('graniteRisk'),
  };
}

/** The process step's output for SCORED with top N 3, as the chain hands it on. */
function afterProcess() {
  return stateOf({ scored: SCORED, selected: SCORED.slice(0, 3), afterProcess: 6 });
}

describe('guardCandidates', () => {
  it('checks only the picks with the model guards when none is flagged', async () => {
    const { rule, clef, granite } = guards();
    const h = contextFor({ config: { topN: 3 }, inputGuards: [rule, clef, granite] });

    const next = await guardCandidates(h.ctx, afterProcess(), h.logger);

    expect(titles(next.selected)).toEqual(['Release 0', 'Release 1', 'Release 2']);
    expect(titles(clef.calls)).toEqual(['Release 0', 'Release 1', 'Release 2']);
    expect(granite.calls).toHaveLength(3);
    expect(rule.calls).toEqual([]);
    expect(next.guardedCandidates).toBe(3);
    expect(next.settled).toBeUndefined();
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        level: 'info',
        message: 'Candidate guards done',
        fields: expect.objectContaining({ kept: 3, dropped: 0, checked: 3, rounds: 1 }) as object,
      }),
    );
  });

  it('replaces a flagged pick with the next item the process step ranks', async () => {
    const { rule, clef, granite } = guards(titled('Release 1'));
    const h = contextFor({ config: { topN: 3 }, inputGuards: [rule, clef, granite] });

    const next = await guardCandidates(h.ctx, afterProcess(), h.logger);

    expect(titles(next.selected)).toEqual(['Release 0', 'Release 2', 'Release 3']);
    expect(next.guardedCandidates).toBe(6);
  });

  it('keeps out what an earlier week sent when it picks a replacement', async () => {
    const { rule, clef, granite } = guards(titled('Release 0'));
    const h = contextFor({ config: { topN: 3 }, inputGuards: [rule, clef, granite] });
    h.store.records.set(
      '2026-W41',
      makeRunRecord({ runId: '2026-W41', status: 'sent', sentUrls: [SCORED[3]!.url] }),
    );
    const state = stateOf({ scored: SCORED, selected: SCORED.slice(0, 3), afterProcess: 5 });

    const next = await guardCandidates(h.ctx, state, h.logger);

    expect(titles(next.selected)).toEqual(['Release 1', 'Release 2', 'Release 4']);
  });

  it('settles the week quiet when fewer than 3 items pass', async () => {
    const { rule, clef, granite } = guards(
      titled('Release 0', 'Release 1', 'Release 2', 'Release 3'),
    );
    const h = contextFor({ config: { topN: 3 }, inputGuards: [rule, clef, granite] });

    const next = await guardCandidates(h.ctx, afterProcess(), h.logger);

    expect(titles(next.selected)).toEqual(['Release 4', 'Release 5']);
    expect(next.settled).toEqual({ status: 'quiet' });
  });

  it('does nothing when the model guards already ran before classify (rescoreWithWriter)', async () => {
    const { rule, clef, granite } = guards(() => true);
    const h = contextFor({
      config: { topN: 3, models: { rescoreWithWriter: true } },
      inputGuards: [rule, clef, granite],
    });
    const state = afterProcess();

    const next = await guardCandidates(h.ctx, state, h.logger);

    expect(next).toBe(state);
    expect(clef.calls).toEqual([]);
  });

  it('leaves every other part of the state alone', async () => {
    const { rule, clef, granite } = guards();
    const h = contextFor({ config: { topN: 3 }, inputGuards: [rule, clef, granite] });
    const state = afterProcess();

    const next = await guardCandidates(h.ctx, state, h.logger);

    expect(next).toEqual({ ...state, selected: next.selected, guardedCandidates: 3 });
  });
});

describe('guardCandidates when the run is told to stop', () => {
  it('hands the run signal to every model guard call', async () => {
    const controller = new AbortController();
    const seen: (GuardCallOptions | undefined)[] = [];
    const clef: InputGuard = {
      id: 'clefPolicy',
      checkItem: (_item, options) => {
        seen.push(options);
        return Promise.resolve({ check: 'clefPolicy', flagged: false });
      },
    };
    const h = contextFor({ config: { topN: 3 }, inputGuards: [clef], signal: controller.signal });

    await guardCandidates(h.ctx, afterProcess(), h.logger);

    expect(seen).toHaveLength(3);
    expect(seen.every((options) => options?.signal === controller.signal)).toBe(true);
  });
});
