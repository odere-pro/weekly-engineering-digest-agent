// The grounding and classifier case sets through runEval: how the output guards and the app
// model are scored. classifierRun/ tests the two checks themselves.
import { describe, expect, it } from 'vitest';
import { runEval } from './runEval';
import { makeConfig, makeDraft, makeItem } from '../test/builders';
import { FakeOutputGuard } from '../test/fakes';
import { NONE, makeApp, makeDeps, useCasesDir, writeJson } from './evalKit';

const AREA_A = 'AI models and tooling';
const AREA_B = 'Platform engineering';
const root = useCasesDir();

/** Flags a draft whose summaries say INVENTED, like a groundedness guard that caught the claim. */
const groundednessGuard = () =>
  new FakeOutputGuard('graniteGroundedness', (d) =>
    d.digest.items.some((i) => i.summary.includes('INVENTED')),
  );

/** The default output guards of a run: groundedness plus a rubric guard that flags nothing. */
const outputGuards = () => [groundednessGuard(), new FakeOutputGuard('clefRubric')];

describe('grounding cases', () => {
  async function writeGrounding(id: string, plantedSummary: string): Promise<void> {
    const items = [makeItem(), makeItem(), makeItem()];
    const draft = makeDraft(items);
    const digest = {
      ...draft.digest,
      items: draft.digest.items.map((it, i) => (i === 0 ? { ...it, summary: plantedSummary } : it)),
    };
    await writeJson(root(), `grounding/${id}.json`, {
      id,
      draft: { ...draft, digest },
      sources: items,
      plantedItemId: items[0]!.id,
    });
  }

  it('counts planted claims the output guards catch', async () => {
    await writeGrounding('g1', 'It INVENTED a benchmark.');
    await writeGrounding('g2', 'A subtle wrong version.');

    const scorecard = await runEval(
      { profile: 'quality', casesDir: root(), minimums: NONE },
      makeDeps(makeApp({ outputGuards: outputGuards() }), []),
    );

    expect(scorecard.metrics.groundedness).toMatchObject({
      value: 0.5,
      pass: false,
      detail: { graniteGroundedness: 1 },
    });
    expect(scorecard.counts.grounding).toBe(2);
  });

  it('uses the draft without its planted item as a clean control for false blocks', async () => {
    await writeGrounding('g1', 'It INVENTED a benchmark.');
    const app = makeApp({
      outputGuards: [
        new FakeOutputGuard('graniteGroundedness', (d) =>
          d.digest.items.some((i) => i.summary.includes('INVENTED')),
        ),
        // Flags every draft, so it also blocks the clean control.
        new FakeOutputGuard('clefRubric', () => true),
      ],
    });

    const scorecard = await runEval(
      { profile: 'quality', casesDir: root(), minimums: NONE },
      makeDeps(app, []),
    );

    // graniteGroundedness flags the planted draft only; clefRubric then sees the control alone.
    expect(scorecard.metrics.groundedness).toMatchObject({
      value: 1,
      detail: { graniteGroundedness: 1 },
    });
    expect(scorecard.metrics.guardFalseBlocks.detail).toEqual({
      graniteGroundedness: 0,
      clefRubric: 1,
    });
  });

  it('measures a guard that blocks the clean control', async () => {
    await writeGrounding('g1', 'A subtle wrong version.');
    const app = makeApp({
      outputGuards: [
        new FakeOutputGuard('graniteGroundedness', () => true),
        new FakeOutputGuard('clefRubric'),
      ],
    });

    const scorecard = await runEval(
      { profile: 'quality', casesDir: root(), minimums: NONE },
      makeDeps(app, []),
    );

    expect(scorecard.metrics.groundedness.value).toBe(1);
    expect(scorecard.metrics.guardFalseBlocks.detail).toEqual({ graniteGroundedness: 1 });
  });

  it('is not measured when an output guard did not run', async () => {
    await writeGrounding('g1', 'It INVENTED a benchmark.');
    const app = makeApp({
      outputGuards: [new FakeOutputGuard('graniteGroundedness', () => true)],
    });

    const scorecard = await runEval(
      { profile: 'quality', casesDir: root(), minimums: NONE },
      makeDeps(app, []),
    );

    expect(scorecard.metrics.groundedness).toMatchObject({ value: null, pass: false });
    expect(scorecard.metrics.groundedness.note).toContain('guards were off: clefRubric');
  });

  it('skips the control when the planted item is the only item', async () => {
    const [item] = [makeItem()];
    await writeJson(root(), 'grounding/solo.json', {
      id: 'solo',
      draft: makeDraft([item]),
      sources: [item],
      plantedItemId: item.id,
    });

    const scorecard = await runEval(
      { profile: 'quality', casesDir: root(), minimums: NONE },
      makeDeps(makeApp({ outputGuards: outputGuards() }), []),
    );

    expect(scorecard.metrics.guardFalseBlocks.value).toBeNull();
  });
});

describe('classifier cases', () => {
  async function writeClassifier(reviewed: boolean): Promise<void> {
    await writeJson(root(), 'classifier-cases.json', {
      reviewed,
      cases: [
        { item: makeItem({ title: 'C1' }), expected: { area: AREA_B, relevance: 3 } },
        { item: makeItem({ title: 'C2' }), expected: { area: AREA_A, relevance: 1 } },
      ],
    });
  }

  it('scores area and relevance against the labels with the app model', async () => {
    await writeClassifier(true);
    const app = makeApp({
      classify: { C1: { area: AREA_B, level: 3 }, C2: { area: AREA_B, level: 1 } },
    });

    const scorecard = await runEval(
      { profile: 'quality', casesDir: root(), minimums: NONE },
      makeDeps(app, []),
    );

    expect(scorecard.metrics.classifierAccuracy).toMatchObject({
      value: 1,
      pass: true,
      detail: { area: 0.5, relevanceWithinOne: 1, spearman: 1 },
    });
    expect(scorecard.metrics.classifierAccuracy.note).toBeUndefined();
    expect(app.model.decideCalls.every((c) => c.role === 'classify')).toBe(true);
    expect(scorecard.counts.classifier).toBe(2);
  });

  it('passes the source area tag of the config into the classify prompt', async () => {
    await writeClassifier(true);
    const app = makeApp({
      classify: { C1: { area: AREA_B, level: 3 }, C2: { area: AREA_A, level: 1 } },
      config: makeConfig({
        guards: { input: { mode: 'all' }, output: { enabled: false } },
        sources: [
          {
            id: 'example-feed',
            kind: 'rss',
            url: 'https://example.com/feed.xml',
            area: 'platform',
          },
        ],
      }),
    });

    await runEval({ profile: 'quality', casesDir: root(), minimums: NONE }, makeDeps(app, []));

    const states = app.model.decideCalls
      .filter((call) => call.role === 'classify')
      .map((call) => call.state);
    expect(states).toHaveLength(2);
    for (const state of states) expect(state).toContain('Source tag: platform');
  });

  it('flags labels the maintainer has not reviewed yet', async () => {
    await writeClassifier(false);
    const app = makeApp({
      classify: { C1: { area: AREA_B, level: 3 }, C2: { area: AREA_A, level: 1 } },
    });

    const scorecard = await runEval(
      { profile: 'quality', casesDir: root(), minimums: NONE },
      makeDeps(app, []),
    );

    expect(scorecard.metrics.classifierAccuracy).toMatchObject({ value: 1, pass: true });
    expect(scorecard.metrics.classifierAccuracy.note).toMatch(/not reviewed/);
  });
});
