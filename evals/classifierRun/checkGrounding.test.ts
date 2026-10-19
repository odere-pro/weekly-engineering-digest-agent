import { describe, expect, it } from 'vitest';
import { makeDraft, makeItem } from '../../test/builders';
import { FakeOutputGuard } from '../../test/fakes';
import { makeApp } from '../evalKit';
import type { GroundingCase } from '../schema';
import { checkGrounding } from './checkGrounding';

/** A draft of `count` items whose first item carries the planted claim. */
function groundingCase(id: string, plantedSummary: string, count = 3): GroundingCase {
  const items = Array.from({ length: count }, () => makeItem());
  const draft = makeDraft(items);
  const planted = draft.digest.items.map((it, i) =>
    i === 0 ? { ...it, summary: plantedSummary } : it,
  );
  return {
    id,
    draft: { ...draft, digest: { ...draft.digest, items: planted } },
    sources: items,
    plantedItemId: items[0]!.id,
  };
}

/** Flags a draft whose summaries say INVENTED, like a groundedness guard that caught the claim. */
const groundedness = () =>
  new FakeOutputGuard('graniteGroundedness', (d) =>
    d.digest.items.some((i) => i.summary.includes('INVENTED')),
  );

describe('checkGrounding', () => {
  it('counts a planted claim as caught when an output guard rejects the draft, and names the guard', async () => {
    const app = makeApp({ outputGuards: [groundedness(), new FakeOutputGuard('clefRubric')] });

    const { outcomes } = await checkGrounding(app.deps, [
      groundingCase('g1', 'It INVENTED a benchmark.'),
      groundingCase('g2', 'A subtle wrong version.'),
    ]);

    expect(outcomes).toEqual([
      { caseId: 'g1', caught: true, flaggedBy: ['graniteGroundedness'] },
      { caseId: 'g2', caught: false, flaggedBy: [] },
    ]);
  });

  it('checks the draft together with a clean control, the draft without the planted item', async () => {
    const guard = groundedness();
    const app = makeApp({ outputGuards: [guard] });
    const planted = groundingCase('g1', 'It INVENTED a benchmark.');

    await checkGrounding(app.deps, [planted]);

    expect(guard.calls).toHaveLength(2);
    const control = guard.calls.find((draft) => draft !== planted.draft)!;
    expect(control.digest.items.map((item) => item.itemId)).toEqual(
      planted.draft.digest.items.slice(1).map((item) => item.itemId),
    );
  });

  it('tallies a guard that blocks the clean control as a false block', async () => {
    const app = makeApp({
      outputGuards: [groundedness(), new FakeOutputGuard('clefRubric', () => true)],
    });

    const { tallies, outcomes } = await checkGrounding(app.deps, [
      groundingCase('g1', 'It INVENTED a benchmark.'),
    ]);

    // graniteGroundedness only flags the planted draft; clefRubric flags the control too.
    expect(tallies).toEqual({
      graniteGroundedness: { checked: 1, flagged: 0 },
      clefRubric: { checked: 1, flagged: 1 },
    });
    // In mode any the later guard never sees a draft an earlier one flagged.
    expect(outcomes[0]?.flaggedBy).toEqual(['graniteGroundedness']);
  });

  it('skips the control when the planted item is the only item', async () => {
    const guard = groundedness();
    const app = makeApp({ outputGuards: [guard] });

    const { tallies, outcomes } = await checkGrounding(app.deps, [
      groundingCase('solo', 'It INVENTED a benchmark.', 1),
    ]);

    expect(guard.calls).toHaveLength(1);
    expect(tallies).toEqual({});
    expect(outcomes[0]?.caught).toBe(true);
  });

  it('names the output checks that did not run', async () => {
    const app = makeApp({ outputGuards: [new FakeOutputGuard('graniteGroundedness', () => true)] });

    const { disabledChecks } = await checkGrounding(app.deps, [groundingCase('g1', 'x')]);

    expect(disabledChecks).toEqual(['clefRubric']);
  });

  it('runs every guard whatever the app config says about the output guards', async () => {
    const guard = groundedness();
    // makeApp switches the output guards off in its config; the grounding check must not care.
    const app = makeApp({ outputGuards: [guard, new FakeOutputGuard('clefRubric')] });
    expect(app.deps.config.guards.output.enabled).toBe(false);

    const { disabledChecks } = await checkGrounding(app.deps, [
      groundingCase('g1', 'It INVENTED a benchmark.'),
    ]);

    expect(disabledChecks).toEqual([]);
    expect(guard.calls.length).toBeGreaterThan(0);
  });

  it('is empty for no cases', async () => {
    const app = makeApp();

    expect(await checkGrounding(app.deps, [])).toEqual({
      outcomes: [],
      tallies: {},
      disabledChecks: [],
    });
  });
});
