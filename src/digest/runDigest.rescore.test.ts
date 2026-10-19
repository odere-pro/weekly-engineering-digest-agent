// The classify stage passes models.rescoreWithWriter and thresholds.minRelevance on, so the key
// does what the config says. Off by default: a run with the flag off is the plain run.
import { describe, expect, it } from 'vitest';
import { runDigest, type DigestDeps } from './runDigest';
import { QUESTION_IDS } from '../classify/classifyPrompt';
import { requiredModels, type ModelProfile } from '../config/profiles';
import type { ConfigInput } from '../config/schema';
import type { Item } from '../domain/schemas';
import type { DecisionAnswer } from '../models/ModelProvider';
import { DATA_OPEN } from '../shared/untrusted';
import { makeConfig, makeItem } from '../../test/builders';
import {
  CapturingDelivery,
  FakeInputGuard,
  FakeModelProvider,
  FakeOutputGuard,
  FakeSourceFetcher,
  MemoryRunStore,
  fixedClock,
  noopLogger,
  noopTracer,
} from '../../test/fakes';

const WEEK = '2026-W42';
const AREA = 'AI models and tooling';
const WRITER = 'writer-a:31b';
const RESCORED = 3;
const PROFILE: ModelProfile = {
  name: 'quality',
  classify: 'classifier:2b',
  guardPolicy: 'policy:2b',
  guardRisk: 'risk:8b',
  writers: [WRITER],
  judge: null,
  requiresAppleSilicon: false,
  minOllamaVersion: '0.0.0',
};

/** What the decider answers per item, by title: two clear passes, one on the default floor, two below. */
const LEVELS: Readonly<Record<string, number>> = {
  'Runner 1.0 ships': 2.5,
  'Runner 2.0 ships': 2,
  'Runner 3.0 ships': 1.5,
  'Runner 4.0 ships': 1.2,
  'Runner 5.0 ships': 0.5,
};

const score = (level: number): DecisionAnswer => ({
  type: 'score',
  level,
  score: level / 3,
  probabilities: {},
  confidence: 0.9,
});

/** Built once, so two runs of a test see the same item ids. */
const ITEMS = Object.keys(LEVELS).map((title) =>
  makeItem({ title, publishedAt: '2026-10-14T09:00:00Z' }),
);

function setup(config: Partial<ConfigInput> = {}) {
  const items = ITEMS;
  const named = (text: string, wanted: readonly Item[]): Item[] =>
    wanted.filter((item) => text.includes(`${DATA_OPEN} ${item.id}>>>`));
  const model = new FakeModelProvider({
    health: {
      reachable: true,
      models: requiredModels(PROFILE).map((name) => ({ name, capabilities: [] })),
    },
    decide: (request) => {
      const item = items.find((entry) => request.state.includes(entry.title));
      return {
        [QUESTION_IDS.relevance]: score(LEVELS[item?.title ?? ''] ?? 0),
        [QUESTION_IDS.area]: { type: 'choice', choice: AREA, probabilities: {}, confidence: 0.9 },
        [QUESTION_IDS.hype]: { type: 'yesno', probability: 0.1 },
        [QUESTION_IDS.minorRelease]: { type: 'yesno', probability: 0.1 },
      };
    },
    generate: (request) => {
      const given = named(request.prompt, items);
      if (request.prompt.includes('Rescore these')) {
        return JSON.stringify({
          items: given.map((item) => ({
            itemId: item.id,
            relevance: RESCORED,
            area: AREA,
            confidence: 'high',
          })),
        });
      }
      return JSON.stringify({
        headline: 'Runners moved this week',
        intro: 'These releases change how teams ship.',
        items: given.map((item) => ({
          itemId: item.id,
          title: item.title,
          url: item.url,
          area: AREA,
          summary: `${item.title} is out.`,
          whyItMatters: 'Teams can cut CI time.',
          urgency: 'worth-a-look',
          action: 'Relevant if you run it.',
        })),
      });
    },
  });
  const store = new MemoryRunStore();
  const deps: DigestDeps = {
    config: makeConfig({ focusAreas: [AREA, 'Platform engineering'], ...config }),
    profile: PROFILE,
    model,
    fetchers: { rss: new FakeSourceFetcher('rss', { 'example-feed': items }) },
    inputGuards: [new FakeInputGuard('clefPolicy'), new FakeInputGuard('graniteRisk')],
    outputGuards: [new FakeOutputGuard('graniteGroundedness'), new FakeOutputGuard('clefRubric')],
    deliveries: [new CapturingDelivery('markdown')],
    store,
    logger: noopLogger,
    tracer: noopTracer,
    clock: fixedClock('2026-10-16T08:00:00Z'),
  };
  const rescoreCalls = () =>
    model.generateCalls.filter((call) => call.prompt.includes('Rescore these'));
  const relevances = (): number[] =>
    (JSON.parse(store.artifacts.get(`${WEEK}/scores.json`) ?? '[]') as { relevance: number }[]).map(
      (entry) => entry.relevance,
    );
  return {
    items,
    rescoreCalls,
    relevances,
    scoresJson: () => store.artifacts.get(`${WEEK}/scores.json`),
    sentTo: (call: { prompt: string }) => named(call.prompt, items).map((item) => item.title),
    run: () => runDigest(deps, { dryRun: true }),
  };
}

describe('runDigest: models.rescoreWithWriter', () => {
  it('sends the items at or above minRelevance to the write role, and not the one below', async () => {
    const h = setup({ models: { rescoreWithWriter: true } });

    await h.run();

    const [call, ...others] = h.rescoreCalls();
    expect(others).toEqual([]);
    expect(call?.role).toBe('write');
    expect(h.sentTo(call!)).toEqual(['Runner 1.0 ships', 'Runner 2.0 ships', 'Runner 3.0 ships']);
  });

  it('writes the rescored relevance to scores.json', async () => {
    const h = setup({ models: { rescoreWithWriter: true } });

    await h.run();

    expect(h.relevances()).toEqual([RESCORED, RESCORED, RESCORED, 1.2, 0.5]);
  });

  it('makes no write call before the write step and keeps the decider scores when it is off', async () => {
    const h = setup({ models: { rescoreWithWriter: false } });

    await h.run();

    expect(h.rescoreCalls()).toEqual([]);
    expect(h.relevances()).toEqual([2.5, 2, 1.5, 1.2, 0.5]);
  });

  it('leaves scores.json byte-identical to a run that never set the flag', async () => {
    const off = setup({ models: { rescoreWithWriter: false } });
    const unset = setup();

    await off.run();
    await unset.run();

    expect(off.scoresJson()).toBeDefined();
    expect(off.scoresJson()).toBe(unset.scoresJson());
    expect(unset.rescoreCalls()).toEqual([]);
  });

  it('takes the floor from thresholds.minRelevance, not from the schema default', async () => {
    const h = setup({ models: { rescoreWithWriter: true }, thresholds: { minRelevance: 2 } });

    await h.run();

    expect(h.rescoreCalls().map((call) => h.sentTo(call))).toEqual([
      ['Runner 1.0 ships', 'Runner 2.0 ships'],
    ]);
    expect(h.relevances()).toEqual([RESCORED, RESCORED, 1.5, 1.2, 0.5]);
  });
});
