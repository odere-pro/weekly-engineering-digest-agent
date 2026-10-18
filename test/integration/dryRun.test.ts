// Spec phase 1 exit gate: a dry run writes a digest from mock models. Every port is a fake;
// the steps, checks, render and the Mastra workflow are the real ones.
import { describe, expect, it } from 'vitest';
import { runDigest, type DigestDeps } from '../../src/digest/runDigest';
import { ExitCode, RunRecordSchema, type Item } from '../../src/domain/schemas';
import { QUESTION_IDS } from '../../src/classify/classifyPrompt';
import { JUDGE_CRITERIA } from '../../src/select/judgePrompt';
import { PROFILES, requiredModels } from '../../src/config/profiles';
import type {
  DecideRequest,
  DecisionAnswer,
  GenerateRequest,
} from '../../src/models/ModelProvider';
import { DATA_OPEN } from '../../src/shared/untrusted';
import { makeConfig, makeItem } from '../builders';
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
} from '../fakes';

const MODELS_AREA = 'AI models and tooling';
const PLATFORM_AREA = 'Platform engineering';
const PROFILE = PROFILES.quality;

const rssItems: Item[] = [
  makeItem({
    sourceId: 'model-blog',
    title: 'Gemma 4 adds tool calling',
    publishedAt: '2026-10-13T10:00:00Z',
  }),
  makeItem({
    sourceId: 'model-blog',
    title: 'Model router 2.0',
    publishedAt: '2026-10-14T10:00:00Z',
  }),
  makeItem({ sourceId: 'model-blog', title: 'Old news', publishedAt: '2026-09-01T10:00:00Z' }),
];
const githubItems: Item[] = [
  makeItem({
    sourceId: 'runner',
    kind: 'github',
    url: 'https://github.com/example/runner/releases/tag/v3.0.0',
    title: 'runner v3.0.0',
    publishedAt: '2026-10-15T10:00:00Z',
  }),
  makeItem({
    sourceId: 'runner',
    kind: 'github',
    url: 'https://github.com/example/runner/releases/tag/v2.9.1',
    title: 'runner v2.9.1',
    publishedAt: '2026-10-12T10:00:00Z',
  }),
];
const ALL_ITEMS = [...rssItems, ...githubItems];

function itemsIn(text: string): Item[] {
  return ALL_ITEMS.filter((item) => text.includes(`${DATA_OPEN} ${item.id}>>>`));
}

/** Decision model: the patch release is minor, everything else is relevant. */
function decide(request: DecideRequest): Record<string, DecisionAnswer> {
  if (request.role === 'judge') {
    return Object.fromEntries(
      JUDGE_CRITERIA.map((c) => [
        c,
        { type: 'score', level: 3, score: 0.75, probabilities: {}, confidence: 0.8 } as const,
      ]),
    );
  }
  const [item] = itemsIn(request.state);
  const area = item?.kind === 'github' ? PLATFORM_AREA : MODELS_AREA;
  return {
    [QUESTION_IDS.relevance]: {
      type: 'score',
      level: 2.4,
      score: 0.8,
      probabilities: {},
      confidence: 0.9,
    },
    [QUESTION_IDS.area]: { type: 'choice', choice: area, probabilities: {}, confidence: 0.85 },
    [QUESTION_IDS.hype]: { type: 'yesno', probability: 0.05 },
    [QUESTION_IDS.minorRelease]: {
      type: 'yesno',
      probability: item?.title.endsWith('.1') ? 0.9 : 0.1,
    },
  };
}

/** Writer: one item per given source item; the second writer uses an em dash on purpose. */
function generate(request: GenerateRequest): string {
  const dash = request.model === PROFILE.writers[1] ? ' — ' : ': ';
  return JSON.stringify({
    headline: `This week${dash}tool calling and faster runners`,
    intro: 'Three releases worth your time.',
    items: itemsIn(request.prompt).map((item) => ({
      itemId: item.id,
      title: item.title,
      url: item.url,
      area: item.kind === 'github' ? PLATFORM_AREA : MODELS_AREA,
      summary: `${item.title} is out.`,
      whyItMatters: 'Teams can drop a workaround they maintain today.',
      urgency: 'worth-a-look',
      action: 'Relevant if you run it.',
    })),
  });
}

function setup(now: string) {
  const store = new MemoryRunStore();
  const deliveries = [
    new CapturingDelivery('markdown'),
    new CapturingDelivery('email'),
    new CapturingDelivery('slack'),
  ];
  const deps: DigestDeps = {
    config: makeConfig({
      focusAreas: [MODELS_AREA, PLATFORM_AREA],
      sources: [
        { id: 'model-blog', kind: 'rss', url: 'https://example.com/feed.xml' },
        { id: 'runner', kind: 'github', url: 'https://github.com/example/runner' },
        { id: 'broken-feed', kind: 'rss', url: 'https://example.org/feed.xml' },
      ],
    }),
    profile: PROFILE,
    model: new FakeModelProvider({
      decide,
      generate,
      health: {
        reachable: true,
        version: '0.40.4',
        models: requiredModels(PROFILE).map((name) => ({ name, capabilities: ['completion'] })),
      },
    }),
    fetchers: {
      rss: new FakeSourceFetcher('rss', {
        'model-blog': rssItems,
        'broken-feed': new Error('HTTP 404'),
      }),
      github: new FakeSourceFetcher('github', { runner: githubItems }),
    },
    inputGuards: [new FakeInputGuard('clefPolicy'), new FakeInputGuard('graniteRisk')],
    outputGuards: [new FakeOutputGuard('graniteGroundedness'), new FakeOutputGuard('clefRubric')],
    deliveries,
    store,
    logger: noopLogger,
    tracer: noopTracer,
    clock: fixedClock(now),
  };
  return { deps, store, deliveries };
}

describe('integration: one week through the whole chain on fakes', () => {
  it('dry run writes a digest from mock models', async () => {
    const { deps, store, deliveries } = setup('2026-10-16T05:45:00Z');

    const result = await runDigest(deps, { dryRun: true });

    expect(result.exitCode).toBe(ExitCode.Sent);
    const record = RunRecordSchema.parse(store.records.get('2026-W42'));
    expect(record).toEqual(result.record);
    expect(record).toMatchObject({
      status: 'dry-run',
      profile: 'quality',
      counts: { collected: 4, afterGuardInput: 4, classified: 4, selected: 3, digestItems: 3 },
      failedSources: [{ sourceId: 'broken-feed', error: 'HTTP 404' }],
      disabledGuards: [],
      sentUrls: [],
    });
    expect(record.drafts.map((draft) => draft.passed)).toEqual([true, true]);
    expect(record.winner).toBe(PROFILE.writers[0]);

    const digest = store.artifacts.get('2026-W42/digest.md');
    expect(digest).toBe(result.markdown);
    expect(digest).toMatch(
      /^# Week 2026-W42: 3 releases, nothing needs action\n\n_This week: tool calling and faster runners_\n/,
    );
    expect(digest?.match(/^\| \[/gm)).toHaveLength(3);
    expect(digest).toContain('(https://github.com/example/runner/releases/tag/v3.0.0)');
    expect(digest).not.toContain('v2.9.1');
    expect(digest).not.toContain('Old news');
    expect(digest).not.toContain('Guards off this week');

    for (const delivery of deliveries) {
      expect(delivery.digests).toEqual([]);
      expect(delivery.failures).toEqual([]);
    }
  }, 10_000);

  it('sends the week, skips a second run and keeps sent items out of the next week', async () => {
    const week = setup('2026-10-16T05:45:00Z');
    const sent = await runDigest(week.deps);
    const again = await runDigest(week.deps);
    const nextWeek = await runDigest({ ...week.deps, clock: fixedClock('2026-10-19T05:45:00Z') });

    expect(sent.record.status).toBe('sent');
    expect(week.deliveries.map((delivery) => delivery.digests.length)).toEqual([1, 1, 1]);
    expect(again.record.status).toBe('skipped');
    expect(nextWeek.record).toMatchObject({ runId: '2026-W43', status: 'quiet' });
    expect(nextWeek.record.counts.selected).toBe(0);
  }, 15_000);
});
