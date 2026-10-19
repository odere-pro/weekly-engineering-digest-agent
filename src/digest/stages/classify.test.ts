import { describe, expect, it, vi } from 'vitest';
import { classify } from './classify';
import { QUESTION_IDS } from '../../classify/classifyPrompt';
import type { DecisionAnswer } from '../../models/ModelProvider';
import type { ConfigInput } from '../../config/schema';
import { DATA_OPEN } from '../../shared/untrusted';
import { makeItem } from '../../../test/builders';
import { FakeModelProvider } from '../../../test/fakes';
import { AREA, WEEK, contextFor, stateOf } from '../__fixtures__/stageKit';

const LEVELS: Readonly<Record<string, number>> = { High: 2.5, Edge: 1.5, Low: 0.5 };
const items = Object.keys(LEVELS).map((title) => makeItem({ title }));

const score = (level: number): DecisionAnswer => ({
  type: 'score',
  level,
  score: level / 3,
  probabilities: {},
  confidence: 0.9,
});

/** The decider answers by title; the writer, when asked to rescore, gives every item a 3. */
function model() {
  return new FakeModelProvider({
    decide: (request) => {
      const title = items.find((item) => request.state.includes(item.title))?.title ?? '';
      return {
        [QUESTION_IDS.relevance]: score(LEVELS[title] ?? 0),
        [QUESTION_IDS.area]: { type: 'choice', choice: AREA, probabilities: {}, confidence: 0.9 },
        [QUESTION_IDS.hype]: { type: 'yesno', probability: 0.1 },
        [QUESTION_IDS.minorRelease]: { type: 'yesno', probability: 0.1 },
      };
    },
    generate: (request) =>
      JSON.stringify({
        items: items
          .filter((item) => request.prompt.includes(`${DATA_OPEN} ${item.id}>>>`))
          .map((item) => ({ itemId: item.id, relevance: 3, area: AREA, confidence: 'high' })),
      }),
  });
}

function run(config: Partial<ConfigInput> = {}, options: { hold?: boolean } = {}) {
  const fake = model();
  const h = contextFor({ model: fake, config, holdArtifacts: options.hold });
  const result = classify(h.ctx, stateOf({ kept: items }), h.logger);
  return { ...h, fake, result };
}

describe('classify', () => {
  it('scores every kept item, in order, and writes the classifications to scores.json', async () => {
    const h = run();

    const next = await h.result;

    expect(next.scored.map((item) => item.classification.relevance)).toEqual([2.5, 1.5, 0.5]);
    expect(JSON.parse(h.store.artifacts.get(`${WEEK}/scores.json`) ?? '[]')).toEqual(
      next.scored.map((item) => item.classification),
    );
    expect(h.fake.generateCalls).toEqual([]);
  });

  it('holds scores.json when the earlier files of the week must stay', async () => {
    const h = run({}, { hold: true });

    const next = await h.result;

    expect(h.store.artifacts.size).toBe(0);
    expect(next.held.map((artifact) => artifact.name)).toEqual(['scores.json']);
  });

  it('gives the classifier the area tag of the item source', async () => {
    const h = run({
      sources: [
        { id: 'example-feed', kind: 'rss', url: 'https://example.com/feed.xml', area: 'cloud' },
      ],
    });

    await h.result;

    expect(h.fake.decideCalls.every((call) => call.state.includes('cloud'))).toBe(true);
  });

  describe('with models.rescoreWithWriter', () => {
    it('has the write role rescore the items at or above thresholds.minRelevance, and not the one below', async () => {
      const h = run({ models: { rescoreWithWriter: true } });

      const next = await h.result;

      const [call, ...others] = h.fake.generateCalls;
      expect(others).toEqual([]);
      expect(call?.role).toBe('write');
      expect(call?.prompt).toContain(items[0]!.id);
      expect(call?.prompt).toContain(items[1]!.id);
      expect(call?.prompt).not.toContain(items[2]!.id);
      expect(next.scored.map((item) => item.classification.relevance)).toEqual([3, 3, 0.5]);
      expect(JSON.parse(h.store.artifacts.get(`${WEEK}/scores.json`) ?? '[]')).toHaveLength(3);
    });

    it('takes the floor from the config, not from the schema default', async () => {
      const h = run({ models: { rescoreWithWriter: true }, thresholds: { minRelevance: 2 } });

      const next = await h.result;

      expect(h.fake.generateCalls).toHaveLength(1);
      expect(h.fake.generateCalls[0]?.prompt).not.toContain(items[1]!.id);
      expect(next.scored.map((item) => item.classification.relevance)).toEqual([3, 1.5, 0.5]);
    });

    it('makes no write call when it is off, which is the default', async () => {
      const off = run({ models: { rescoreWithWriter: false } });
      const unset = run();

      expect((await off.result).scored).toEqual((await unset.result).scored);
      expect(off.fake.generateCalls).toEqual([]);
      expect(unset.fake.generateCalls).toEqual([]);
    });
  });
});

describe('classify when the run is told to stop', () => {
  const reason = new Error('run timed out');

  /** A decide call that ends only when the signal it is given fires. */
  const hanging = () =>
    new FakeModelProvider({
      decide: (request) =>
        new Promise((_resolve, reject) => {
          request.signal?.addEventListener(
            'abort',
            () => {
              reject(request.signal?.reason as Error);
            },
            { once: true },
          );
        }),
    });

  it('gives the model calls the run signal, and fails with its reason when one is aborted', async () => {
    const controller = new AbortController();
    const fake = hanging();
    const h = contextFor({ model: fake, signal: controller.signal });
    const pending = classify(h.ctx, stateOf({ kept: items }), h.logger);
    await vi.waitFor(() => {
      expect(fake.decideCalls).toHaveLength(1);
    });
    expect(fake.decideCalls[0]?.signal).toBe(controller.signal);

    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(h.store.artifacts.size).toBe(0);
  });

  it('calls no model, and writes no scores, when the signal fired already', async () => {
    const controller = new AbortController();
    controller.abort(reason);
    const fake = hanging();
    const h = contextFor({ model: fake, signal: controller.signal });

    await expect(classify(h.ctx, stateOf({ kept: items }), h.logger)).rejects.toBe(reason);

    expect(fake.decideCalls).toEqual([]);
    expect(h.store.artifacts.size).toBe(0);
  });
});
