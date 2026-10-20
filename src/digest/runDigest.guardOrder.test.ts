// PERF-2 over a whole run: the model input guards check the picks after process, and no model
// that writes text ever reads an item they flagged or did not check.
import { describe, expect, it } from 'vitest';
import { runDigest } from './runDigest';
import type { Item } from '../domain/schemas';
import { DATA_OPEN } from '../shared/untrusted';
import { FakeInputGuard } from '../../test/fakes';
import { setup, weekItems } from './__fixtures__/runKit';

/** Six items, best first: Runner 1.0 ships is the top pick. */
const ITEMS = weekItems(6);
const RELEVANCE = new Map(ITEMS.map((item, index) => [item.id, 3 - index * 0.1]));
const [TOP] = ITEMS as [Item, ...Item[]];

const writerPrompts = (h: ReturnType<typeof setup>): string[] =>
  h.model.generateCalls.filter((call) => call.role === 'write').map((call) => call.prompt);
const shows = (prompt: string, item: Item): boolean =>
  prompt.includes(`${DATA_OPEN} ${item.id}>>>`);

function flaggingTop(h: ReturnType<typeof setup>): FakeInputGuard {
  return new FakeInputGuard('clefPolicy', (item) => {
    h.timeline.push('guard:clefPolicy');
    return item.id === TOP.id;
  });
}

describe('runDigest: the model input guards check the picks (PERF-2)', () => {
  it('classifies first, then guards the picks, and never shows a writer the flagged one', async () => {
    const h = setup({
      items: ITEMS,
      config: { topN: 3 },
      relevance: (item) => RELEVANCE.get(item.id) ?? 0,
    });
    const deps = {
      ...h.deps,
      inputGuards: [
        new FakeInputGuard('ruleInjection'),
        flaggingTop(h),
        new FakeInputGuard('graniteRisk'),
      ],
    };

    const result = await runDigest(deps, { dryRun: true });

    const prompts = writerPrompts(h);
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts.some((prompt) => shows(prompt, TOP))).toBe(false);
    expect(prompts.every((prompt) => shows(prompt, ITEMS[3]!))).toBe(true);
    expect(h.timeline.indexOf('classify')).toBeLessThan(h.timeline.indexOf('guard:clefPolicy'));
    expect(result.record.counts).toMatchObject({ afterGuardInput: 6, guardedCandidates: 6 });
    expect(result.record.timings.map((timing) => timing.step)).toContain('guardCandidates');
  });

  it('runs the model guards before classify and every write call with rescoreWithWriter on', async () => {
    const h = setup({
      items: ITEMS,
      config: { topN: 3, models: { rescoreWithWriter: true } },
      relevance: (item) => RELEVANCE.get(item.id) ?? 0,
    });
    const deps = {
      ...h.deps,
      inputGuards: [
        new FakeInputGuard('ruleInjection'),
        flaggingTop(h),
        new FakeInputGuard('graniteRisk'),
      ],
    };

    const result = await runDigest(deps, { dryRun: true });

    const lastGuard = h.timeline.lastIndexOf('guard:clefPolicy');
    const firstModel = h.timeline.findIndex(
      (entry) => entry === 'classify' || entry.startsWith('write:'),
    );
    expect(lastGuard).toBeGreaterThanOrEqual(0);
    expect(lastGuard).toBeLessThan(firstModel);
    expect(h.timeline.filter((entry) => entry === 'guard:clefPolicy')).toHaveLength(6);
    expect(h.model.generateCalls.some((call) => shows(call.prompt, TOP))).toBe(false);
    expect(result.record.counts).not.toHaveProperty('guardedCandidates');
  });
});
