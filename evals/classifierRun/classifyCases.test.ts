import { describe, expect, it } from 'vitest';
import type { DecisionAnswer, GenerateRequest } from '../../src/models/ModelProvider';
import { makeConfig, makeItem } from '../../test/builders';
import { FakeModelProvider } from '../../test/fakes';
import { makeApp, type ClassifyTable } from '../evalKit';
import type { ClassifierCase } from '../schema';
import { classifyCases } from './classifyCases';

const AREA_A = 'AI models and tooling';
const AREA_B = 'Platform engineering';

const labeled = (title: string, area: string, relevance: number): ClassifierCase => ({
  item: makeItem({ title }),
  expected: { area, relevance },
});

describe('classifyCases', () => {
  const cases = [labeled('C1', AREA_B, 3), labeled('C2', AREA_A, 1)];
  const table: ClassifyTable = {
    C1: { area: AREA_B, level: 3 },
    C2: { area: AREA_B, level: 2 },
  };

  it('returns nothing, and calls no model, for no cases', async () => {
    const app = makeApp({ classify: table });

    expect(await classifyCases(app.deps, [])).toEqual([]);
    expect(app.model.decideCalls).toEqual([]);
  });

  it('pairs each label with what the app model said, in case order', async () => {
    const app = makeApp({ classify: table });

    const results = await classifyCases(app.deps, cases);

    expect(results).toEqual([
      { expected: cases[0]!.expected, actual: { area: AREA_B, relevance: 3 } },
      { expected: cases[1]!.expected, actual: { area: AREA_B, relevance: 2 } },
    ]);
    expect(app.model.decideCalls.every((call) => call.role === 'classify')).toBe(true);
    expect(app.model.decideCalls).toHaveLength(2);
  });

  it('puts the source area tag of the config into the classify prompt', async () => {
    const app = makeApp({
      classify: table,
      config: makeConfig({
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

    await classifyCases(app.deps, cases);

    for (const call of app.model.decideCalls) expect(call.state).toContain('Source tag: platform');
  });

  describe('rescoring with the writer model (models.rescoreWithWriter)', () => {
    const decide = (): Record<string, DecisionAnswer> => ({
      relevance: { type: 'score', level: 2, score: 2 / 3, probabilities: {}, confidence: 1 },
      area: { type: 'choice', choice: AREA_A, probabilities: {}, confidence: 1 },
      hype: { type: 'yesno', probability: 0 },
      minorRelease: { type: 'yesno', probability: 0 },
    });

    /** The writer says relevance 3 for every item it is sent. */
    const writerReply = (request: GenerateRequest): string => {
      const ids = [...request.prompt.matchAll(/<<<DATA ([\w.:-]+)>>>/g)].map((match) => match[1]);
      return JSON.stringify({
        items: ids.map((itemId) => ({ itemId, relevance: 3, area: AREA_A, confidence: 'high' })),
      });
    };

    const appWith = (flag: boolean, minRelevance = 1.5) => {
      const model = new FakeModelProvider({ decide, generate: writerReply });
      const app = makeApp({
        model,
        config: makeConfig({ models: { rescoreWithWriter: flag }, thresholds: { minRelevance } }),
      });
      return { app, model };
    };

    it('makes a write-role call when the flag is on', async () => {
      const { app, model } = appWith(true);

      await classifyCases(app.deps, cases);

      expect(model.generateCalls.map((call) => call.role)).toEqual(['write']);
    });

    it('makes no write-role call when the flag is off, which is the default', async () => {
      const { app, model } = appWith(false);

      const results = await classifyCases(app.deps, cases);

      expect(model.generateCalls).toEqual([]);
      expect(results.map((result) => result.actual.relevance)).toEqual([2, 2]);
    });

    it('is off in the default config', async () => {
      const model = new FakeModelProvider({ decide });
      const app = makeApp({ model });

      await classifyCases(app.deps, cases);

      expect(model.generateCalls).toEqual([]);
    });

    it('scores with the writer relevance when the flag is on', async () => {
      const { app } = appWith(true);

      const results = await classifyCases(app.deps, cases);

      expect(results.map((result) => result.actual.relevance)).toEqual([3, 3]);
    });

    it('sends only the items at or above thresholds.minRelevance of the config', async () => {
      const { app, model } = appWith(true, 2.5);

      const results = await classifyCases(app.deps, cases);

      // The decider scores both 2, below 2.5: nothing is sent to the writer.
      expect(model.generateCalls).toEqual([]);
      expect(results.map((result) => result.actual.relevance)).toEqual([2, 2]);
    });
  });
});
