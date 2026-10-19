// What runDigest does with the writer retry (W5-06, F1). The retry itself, the rejection log and
// the problem bounds are tested on `writeCheckedStep` in `write/write.checked.test.ts`; this file
// keeps only what the run owns: the retry flag in drafts.json, the record, the guards seeing the
// final draft, and no model text in the record or the failure note.
import { describe, expect, it } from 'vitest';
import { runDigest } from './runDigest';
import { type DigestDeps, type RunOptions } from './types';
import type { Digest, Draft, Item } from '../domain/schemas';
import { QUESTION_IDS } from '../classify/classifyPrompt';
import { requiredModels, type ModelProfile } from '../config/profiles';
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
const NOW = '2026-10-16T08:00:00Z';
const PUBLISHED = '2026-10-14T09:00:00Z';
const AREA = 'AI models and tooling';
const WRITER_A = 'writer-a:31b';
const WRITER_B = 'writer-b:30b';
const EVIL = 'https://evil.example/payload';

const PROFILE: ModelProfile = {
  name: 'quality',
  classify: 'classifier:2b',
  guardPolicy: 'policy:2b',
  guardRisk: 'risk:8b',
  writers: [WRITER_A, WRITER_B],
  judge: null,
  requiresAppleSilicon: false,
  minOllamaVersion: '0.0.0',
};
const SINGLE_WRITER: ModelProfile = { ...PROFILE, writers: [WRITER_A] };

type DigestBody = Omit<Digest, 'weekId'>;

const scoreAnswer = (level: number, top: number): DecisionAnswer => ({
  type: 'score',
  level,
  score: level / top,
  probabilities: {},
  confidence: 0.9,
});

function bodyFor(items: readonly Item[]): DigestBody {
  return {
    headline: 'Runners and gateways moved this week',
    intro: 'These releases change how teams build and ship.',
    items: items.map((item) => ({
      itemId: item.id,
      title: item.title,
      url: item.url,
      area: AREA,
      summary: `${item.title} with faster builds.`,
      whyItMatters: 'Teams can cut CI time without new hardware.',
      urgency: 'worth-a-look',
      action: 'Relevant if you run it.',
    })),
  };
}

/** The body with an unknown URL in the first item's summary: the link check rejects it. */
function withBadLink(body: DigestBody): DigestBody {
  const [first, ...rest] = body.items;
  return { ...body, items: [{ ...first!, summary: `Details at ${EVIL} today.` }, ...rest] };
}

/** `reply` gets the writer and its attempt (1, or 2 for the retry) and the items it was given. */
function setup(
  profile: ModelProfile,
  reply: (writer: string, attempt: number, items: Item[]) => unknown,
) {
  const items = Array.from({ length: 4 }, (_, index) =>
    makeItem({ title: `Runner ${index + 1}.0 ships`, publishedAt: PUBLISHED }),
  );
  const attempts = new Map<string, number>();
  const model = new FakeModelProvider({
    health: {
      reachable: true,
      models: requiredModels(profile).map((name) => ({ name, capabilities: [] })),
    },
    // No judge in these profiles, so every decision is a classify question.
    decide: () => ({
      [QUESTION_IDS.relevance]: scoreAnswer(2.5, 3),
      [QUESTION_IDS.area]: { type: 'choice', choice: AREA, probabilities: {}, confidence: 0.9 },
      [QUESTION_IDS.hype]: { type: 'yesno', probability: 0.1 },
      [QUESTION_IDS.minorRelease]: { type: 'yesno', probability: 0.1 },
    }),
    generate: (request) => {
      const writer = request.model ?? '';
      const attempt = (attempts.get(writer) ?? 0) + 1;
      attempts.set(writer, attempt);
      const given = items.filter((item) => request.prompt.includes(`${DATA_OPEN} ${item.id}>>>`));
      const body = reply(writer, attempt, given);
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  });
  const outputGuards = [
    new FakeOutputGuard('graniteGroundedness'),
    new FakeOutputGuard('clefRubric'),
  ];
  const store = new MemoryRunStore();
  const deps: DigestDeps = {
    config: makeConfig({ focusAreas: [AREA, 'Platform engineering'] }),
    profile,
    model,
    fetchers: { rss: new FakeSourceFetcher('rss', { 'example-feed': items }) },
    inputGuards: [new FakeInputGuard('clefPolicy'), new FakeInputGuard('graniteRisk')],
    outputGuards,
    deliveries: [new CapturingDelivery('markdown'), new CapturingDelivery('email')],
    store,
    logger: noopLogger,
    tracer: noopTracer,
    clock: fixedClock(NOW),
  };
  const draftsFile = () =>
    JSON.parse(store.artifacts.get(`${WEEK}/drafts.json`) ?? '{}') as {
      drafts: Draft[];
      failures: { writer: string; error: string; retry?: boolean }[];
      rejections: { writer: string; attempt: number }[];
    };
  return {
    run: (options: RunOptions = { dryRun: true }) => runDigest(deps, options),
    outputGuards,
    deliveries: deps.deliveries as CapturingDelivery[],
    draftsFile,
  };
}

describe('runDigest: the writer retry', () => {
  it('flags a failed retry in drafts.json, next to the first failures and the rejections', async () => {
    const h = setup(
      { ...PROFILE, writers: [WRITER_A, WRITER_B, 'writer-c:9b'] },
      (writer, attempt, items) => {
        if (writer === 'writer-c:9b') throw new Error('out of memory');
        if (attempt === 1) return withBadLink(bodyFor(items));
        if (writer === WRITER_A) throw new Error('model timed out');
        return bodyFor(items);
      },
    );

    const result = await h.run();

    expect(result.record).toMatchObject({ status: 'dry-run', winner: WRITER_B });
    expect(result.record.drafts).toEqual([
      { writer: WRITER_A, passed: false, rejectedBy: ['linkCheck'] },
      { writer: WRITER_B, passed: true, rejectedBy: [] },
      { writer: 'writer-c:9b', passed: false, rejectedBy: ['write'] },
    ]);
    const file = h.draftsFile();
    expect(file.drafts.map((draft) => draft.writer)).toEqual([WRITER_A, WRITER_B]);
    expect(file.rejections.map((r) => `${r.writer}#${r.attempt}`)).toEqual([
      `${WRITER_A}#1`,
      `${WRITER_B}#1`,
    ]);
    expect(file.failures.map((failure) => [failure.writer, failure.retry])).toEqual([
      ['writer-c:9b', undefined],
      [WRITER_A, true],
    ]);
  });

  it('runs the output guards on the retried draft, not on the rejected one', async () => {
    const h = setup(SINGLE_WRITER, (_writer, attempt, items) =>
      attempt === 1 ? withBadLink(bodyFor(items)) : bodyFor(items),
    );

    await h.run();

    for (const guard of h.outputGuards) {
      expect(guard.calls).toHaveLength(1);
      expect(JSON.stringify(guard.calls[0])).not.toContain('evil.example');
    }
  });

  it('keeps the rejected model text out of the record and the failure note when the retry fails too', async () => {
    const h = setup(SINGLE_WRITER, (_writer, _attempt, items) => withBadLink(bodyFor(items)));

    const result = await h.run({ noFallback: true });

    expect(result.record.status).toBe('blocked');
    expect(JSON.stringify(result.record)).not.toContain('evil.example');
    for (const delivery of h.deliveries) {
      expect(delivery.failures).toEqual([
        {
          weekId: WEEK,
          step: 'guardOutput',
          message: `every draft was rejected: ${WRITER_A} (linkCheck)`,
        },
      ]);
    }
  });
});
