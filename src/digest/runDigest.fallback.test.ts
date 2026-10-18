// The template-only floor (W11-02): a week where no draft survives the checks or the guards is
// still sent, from the selected items' own text, with no model call.
import { describe, expect, it } from 'vitest';
import { runDigest, type DigestDeps, type RunOptions } from './runDigest';
import { RunRecordSchema } from '../store/runRecord';
import { type Draft, type Item } from '../domain/schemas';
import { QUESTION_IDS } from '../classify/classifyPrompt';
import { requiredModels, type ModelProfile } from '../config/profiles';
import { FALLBACK_NOTE } from '../render/layout';
import { readSavedView } from '../render/markdown';
import { FALLBACK_WRITER } from '../write/fallbackDigest';
import type { DecisionAnswer } from '../models/ModelProvider';
import type { LogFields, Logger } from '../shared/telemetry';
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
  noopTracer,
} from '../../test/fakes';

const WEEK = '2026-W42';
const AREA = 'AI models and tooling';
const WRITER = 'writer-a:31b';
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
const EVIL = 'https://evil.example/payload';

const score = (level: number, top: number): DecisionAnswer => ({
  type: 'score',
  level,
  score: level / top,
  probabilities: {},
  confidence: 0.9,
});

function body(items: readonly Item[], summary = (item: Item) => `${item.title} is out.`) {
  return {
    headline: 'Runners moved this week',
    intro: 'These releases change how teams ship.',
    items: items.map((item) => ({
      itemId: item.id,
      title: item.title,
      url: item.url,
      area: AREA,
      summary: summary(item),
      whyItMatters: 'Teams can cut CI time.',
      urgency: 'worth-a-look',
      action: 'Relevant if you run it.',
    })),
  };
}

interface Scenario {
  /** Build the writer's reply from the items it was given. */
  reply?: (items: readonly Item[]) => unknown;
  flagOutput?: (draft: Draft) => boolean;
}

function setup(scenario: Scenario = {}) {
  const items = Array.from({ length: 4 }, (_, i) =>
    makeItem({
      title: `Runner ${i + 1}.0 ships`,
      summary: `Runner ${i + 1}.0 has faster builds. It also fixes caching.`,
      publishedAt: '2026-10-14T09:00:00Z',
    }),
  );
  const warnings: { message: string; fields: LogFields }[] = [];
  let writerCalls = 0;
  const model = new FakeModelProvider({
    health: {
      reachable: true,
      models: requiredModels(PROFILE).map((name) => ({ name, capabilities: [] })),
    },
    decide: () => ({
      [QUESTION_IDS.relevance]: score(2.5, 3),
      [QUESTION_IDS.area]: { type: 'choice', choice: AREA, probabilities: {}, confidence: 0.9 },
      [QUESTION_IDS.hype]: { type: 'yesno', probability: 0.1 },
      [QUESTION_IDS.minorRelease]: { type: 'yesno', probability: 0.1 },
    }),
    generate: (request) => {
      writerCalls += 1;
      const given = items.filter((item) => request.prompt.includes(`${DATA_OPEN} ${item.id}>>>`));
      return JSON.stringify(scenario.reply ? scenario.reply(given) : body(given));
    },
  });
  const logger = (bound: LogFields = {}): Logger => ({
    debug: () => undefined,
    info: () => undefined,
    warn: (message, fields = {}) =>
      void warnings.push({ message, fields: { ...bound, ...fields } }),
    error: () => undefined,
    child: (fields) => logger({ ...bound, ...fields }),
  });
  const store = new MemoryRunStore();
  const deliveries = [new CapturingDelivery('markdown'), new CapturingDelivery('email')];
  const deps: DigestDeps = {
    config: makeConfig({ focusAreas: [AREA, 'Platform engineering'] }),
    profile: PROFILE,
    model,
    fetchers: { rss: new FakeSourceFetcher('rss', { 'example-feed': items }) },
    inputGuards: [new FakeInputGuard('clefPolicy'), new FakeInputGuard('graniteRisk')],
    outputGuards: [
      new FakeOutputGuard('graniteGroundedness', scenario.flagOutput),
      new FakeOutputGuard('clefRubric'),
    ],
    deliveries,
    store,
    logger: logger(),
    tracer: noopTracer,
    clock: fixedClock('2026-10-16T08:00:00Z'),
  };
  return {
    items,
    store,
    deliveries,
    warnings,
    writerCalls: () => writerCalls,
    run: (options: RunOptions = {}) => runDigest(deps, options),
    digestMd: () => store.artifacts.get(`${WEEK}/digest.md`),
  };
}

const badLink = (items: readonly Item[]) => {
  const reply = body(items);
  return {
    ...reply,
    items: [{ ...reply.items[0]!, summary: `See ${EVIL} now.` }, ...reply.items.slice(1)],
  };
};

describe('runDigest: the template-only fallback', () => {
  it('sends a fallback digest when every draft fails the link check', async () => {
    const h = setup({ reply: badLink });

    const result = await h.run();

    expect(result.record).toMatchObject({
      status: 'sent',
      winner: FALLBACK_WRITER,
      fallback: true,
    });
    expect(RunRecordSchema.parse(result.record)).toEqual(result.record);
    expect(result.exitCode).toBe(0);
    expect(result.record.counts.digestItems).toBe(4);
    for (const delivery of h.deliveries) {
      expect(delivery.failures).toEqual([]);
      expect(delivery.digests).toHaveLength(1);
    }
  });

  it('builds it from the items alone: no writer call beyond the first draft and its retry', async () => {
    const h = setup({ reply: badLink });

    await h.run();

    expect(h.writerCalls()).toBe(2);
  });

  it('shows the footer line and reads back as a digest with the items own links', async () => {
    const h = setup({ reply: badLink });

    const result = await h.run();

    const markdown = h.digestMd() ?? '';
    expect(markdown).toContain(FALLBACK_NOTE);
    expect(markdown).not.toContain('evil.example');
    expect(readSavedView(markdown)?.footer).toContain(FALLBACK_NOTE);
    expect(result.record.sentUrls.sort()).toEqual(h.items.map((i) => i.url).sort());
    expect(result.message?.view?.footer).toContain(FALLBACK_NOTE);
  });

  it('saves the fallback draft in drafts.json, so the record winner can be found', async () => {
    const h = setup({ reply: badLink });

    await h.run();

    const file = JSON.parse(h.store.artifacts.get(`${WEEK}/drafts.json`) ?? '{}') as {
      drafts: { writer: string }[];
      rejections: unknown[];
    };
    expect(file.drafts.map((d) => d.writer)).toEqual([WRITER, FALLBACK_WRITER]);
    expect(file.rejections).toHaveLength(2);
  });

  it('uses the first whole sentences of the collected summary', async () => {
    const h = setup({ reply: badLink });

    await h.run();

    expect(h.digestMd()).toContain('Runner 1.0 has faster builds. It also fixes caching.');
  });

  it('sends a fallback digest when the guards block every draft, and keeps the verdict', async () => {
    const h = setup({ flagOutput: () => true });

    const result = await h.run();

    expect(result.record).toMatchObject({
      status: 'sent',
      winner: FALLBACK_WRITER,
      fallback: true,
    });
    expect(result.record.drafts).toEqual([
      { writer: WRITER, passed: false, rejectedBy: ['graniteGroundedness'] },
      { writer: FALLBACK_WRITER, passed: false, rejectedBy: ['graniteGroundedness'] },
    ]);
    expect(h.warnings.map((w) => w.message)).toContain('No draft survived; sending the fallback');
    for (const delivery of h.deliveries) expect(delivery.failures).toEqual([]);
  });

  it('records a fallback that the guards did not flag as passed', async () => {
    const h = setup({ flagOutput: (draft) => draft.writer === WRITER });

    const result = await h.run();

    expect(result.record.drafts.at(-1)).toEqual({
      writer: FALLBACK_WRITER,
      passed: true,
      rejectedBy: [],
    });
  });

  it('is a dry run when asked, with the fallback flag and the digest file', async () => {
    const h = setup({ reply: badLink });

    const result = await h.run({ dryRun: true });

    expect(result.record).toMatchObject({ status: 'dry-run', fallback: true });
    expect(result.markdown).toContain(FALLBACK_NOTE);
    expect(h.deliveries.every((d) => d.digests.length === 0)).toBe(true);
  });

  it('does not use it when a draft passes', async () => {
    const h = setup();

    const result = await h.run();

    expect(result.record.winner).toBe(WRITER);
    expect(result.record).not.toHaveProperty('fallback');
    expect(h.digestMd()).not.toContain(FALLBACK_NOTE);
  });

  it('ends blocked as before when noFallback is set', async () => {
    const h = setup({ reply: badLink });

    const result = await h.run({ noFallback: true });

    expect(result.record).toMatchObject({ status: 'blocked', winner: null });
    expect(result.record).not.toHaveProperty('fallback');
    expect(result.exitCode).toBe(2);
    for (const delivery of h.deliveries) {
      expect(delivery.failures).toEqual([
        {
          weekId: WEEK,
          step: 'guardOutput',
          message: `every draft was rejected: ${WRITER} (linkCheck)`,
        },
      ]);
    }
  });
});
