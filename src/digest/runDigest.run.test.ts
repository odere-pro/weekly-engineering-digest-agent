// Run-level behavior W5-06 adds to runDigest: the after-process count (F35), the judge outcome in
// the log (W5-03 follow-up), and the abort signal (F46). The health check follows the guards in
// use (F30): see health/assertModelsReady.test.ts.
import { describe, expect, it, vi } from 'vitest';
import { runDigest } from './runDigest';
import { type DigestDeps, type RunOptions } from './types';
import { ExitCode, type Digest, type Item } from '../domain/schemas';
import { RunRecordSchema, type RunRecord } from '../store/runRecord';
import { QUESTION_IDS } from '../classify/classifyPrompt';
import { JUDGE_CRITERIA } from '../select/judgePrompt';
import { requiredModels, type ModelProfile } from '../config/profiles';
import type { ConfigInput } from '../config/schema';
import type { DecisionAnswer, ModelHealth } from '../models/ModelProvider';
import type { ArtifactName } from '../store/RunStore';
import type { LogFields, Logger } from '../shared/telemetry';
import { DATA_OPEN } from '../shared/untrusted';
import { makeConfig, makeItem, makeRunRecord } from '../../test/builders';
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
const NOW = '2026-10-16T08:00:00Z';
const PUBLISHED = '2026-10-14T09:00:00Z';
const AREA = 'AI models and tooling';
const WRITER_A = 'writer-a:31b';
const WRITER_B = 'writer-b:30b';

const PROFILE: ModelProfile = {
  name: 'quality',
  classify: 'classifier:2b',
  guardPolicy: 'policy:2b',
  guardRisk: 'risk:8b',
  writers: [WRITER_A, WRITER_B],
  judge: 'judge:9b',
  requiresAppleSilicon: false,
  minOllamaVersion: '0.0.0',
};

type DigestBody = Omit<Digest, 'weekId'>;

interface Scenario {
  itemCount?: number;
  profile?: ModelProfile;
  config?: Partial<ConfigInput>;
  /** Listed models; default is every model of the profile. */
  models?: readonly string[];
  /** Relevance level (0-3) per item, by its position in the feed. */
  relevance?: (position: number) => number;
  /** Judge level (0-4) per judge call, in call order; a missing level breaks the judge. */
  judgeLevels?: readonly number[];
  failClassify?: Error;
  /** Runs inside every classify call, so a test can abort mid-step. */
  onClassify?: () => void;
}

interface LogLine {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  fields: LogFields;
}

function recordingLogger(lines: LogLine[], bound: LogFields = {}): Logger {
  const at =
    (level: LogLine['level']) =>
    (message: string, fields: LogFields = {}): void => {
      lines.push({ level, message, fields: { ...bound, ...fields } });
    };
  return {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: (fields) => recordingLogger(lines, { ...bound, ...fields }),
  };
}

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

function setup(scenario: Scenario = {}) {
  const profile = scenario.profile ?? PROFILE;
  const items = Array.from({ length: scenario.itemCount ?? 5 }, (_, index) =>
    makeItem({ title: `Runner ${index + 1}.0 ships`, publishedAt: PUBLISHED }),
  );
  const logs: LogLine[] = [];
  let judgeCalls = 0;
  const health: ModelHealth = {
    reachable: true,
    models: (scenario.models ?? requiredModels(profile)).map((name) => ({
      name,
      capabilities: [],
    })),
  };
  const model = new FakeModelProvider({
    health,
    decide: (request) => {
      if (request.role === 'judge') {
        const level = scenario.judgeLevels ? scenario.judgeLevels[judgeCalls++] : 3;
        if (level === undefined) return {};
        return Object.fromEntries(JUDGE_CRITERIA.map((name) => [name, scoreAnswer(level, 4)]));
      }
      scenario.onClassify?.();
      if (scenario.failClassify) throw scenario.failClassify;
      const position = items.findIndex((item) =>
        request.state.includes(`${DATA_OPEN} ${item.id}>>>`),
      );
      return {
        [QUESTION_IDS.relevance]: scoreAnswer(scenario.relevance?.(position) ?? 2.5, 3),
        [QUESTION_IDS.area]: { type: 'choice', choice: AREA, probabilities: {}, confidence: 0.9 },
        [QUESTION_IDS.hype]: { type: 'yesno', probability: 0.1 },
        [QUESTION_IDS.minorRelease]: { type: 'yesno', probability: 0.1 },
      };
    },
    generate: (request) => {
      const given = items.filter((item) => request.prompt.includes(`${DATA_OPEN} ${item.id}>>>`));
      return JSON.stringify(bodyFor(given));
    },
  });
  const fetcher = new FakeSourceFetcher('rss', { 'example-feed': items });
  const store = new MemoryRunStore();
  const deliveries = [new CapturingDelivery('markdown'), new CapturingDelivery('email')];
  const deps: DigestDeps = {
    config: makeConfig({ focusAreas: [AREA, 'Platform engineering'], ...scenario.config }),
    profile,
    model,
    fetchers: { rss: fetcher },
    inputGuards: [new FakeInputGuard('clefPolicy'), new FakeInputGuard('graniteRisk')],
    outputGuards: [new FakeOutputGuard('graniteGroundedness'), new FakeOutputGuard('clefRubric')],
    deliveries,
    store,
    logger: recordingLogger(logs),
    tracer: noopTracer,
    clock: fixedClock(NOW),
  };
  const run = (options: RunOptions = {}) => runDigest(deps, options);
  const artifact = (name: ArtifactName): string | undefined =>
    store.artifacts.get(`${WEEK}/${name}`);
  return { run, deps, items, model, store, fetcher, deliveries, logs, artifact };
}

type Harness = ReturnType<typeof setup>;

function expectValidRecord(record: RunRecord): void {
  expect(RunRecordSchema.parse(record)).toEqual(record);
}

const logged = (h: Harness, message: string): LogLine[] =>
  h.logs.filter((line) => line.message === message);
const sentNotes = (h: Harness) => h.deliveries.flatMap((delivery) => delivery.failures);
const modelCalls = (h: Harness): number =>
  h.model.decideCalls.length + h.model.generateCalls.length;

describe('runDigest: counts.afterProcess (F35)', () => {
  it('counts the items that passed the process filters, before the top N cut', async () => {
    const h = setup({ itemCount: 5, config: { topN: 3 } });

    const result = await h.run({ dryRun: true });

    expect(result.record.counts).toEqual({
      collected: 5,
      afterGuardInput: 5,
      classified: 5,
      afterProcess: 5,
      selected: 3,
      digestItems: 3,
    });
    expectValidRecord(result.record);
  });

  it('leaves out the items the relevance filter dropped', async () => {
    const h = setup({
      itemCount: 6,
      config: { topN: 3 },
      relevance: (position) => (position < 2 ? 0 : 2.5),
    });

    const result = await h.run({ dryRun: true });

    expect(result.record.counts).toMatchObject({ classified: 6, afterProcess: 4, selected: 3 });
  });

  it('is set on a quiet week too', async () => {
    const h = setup({ itemCount: 5, relevance: (position) => (position < 3 ? 0 : 2.5) });

    const result = await h.run();

    expect(result.record.status).toBe('quiet');
    expect(result.record.counts).toMatchObject({ afterProcess: 2, selected: 2, digestItems: 0 });
  });

  it('is absent when the run failed before the process step', async () => {
    const h = setup({ failClassify: new Error('classifier timed out') });

    const result = await h.run();

    expect(result.record.status).toBe('failed');
    expect('afterProcess' in result.record.counts).toBe(false);
    expectValidRecord(result.record);
  });
});

describe('runDigest: whether the judge picked the winner', () => {
  const winnerLine = (h: Harness) => logged(h, 'Winner chosen')[0]?.fields;

  it('logs judged: true when the scores picked the winner', async () => {
    const h = setup({ judgeLevels: [1, 3] });

    const result = await h.run({ dryRun: true });

    expect(result.record.winner).toBe(WRITER_B);
    expect(winnerLine(h)).toMatchObject({ writer: WRITER_B, judged: true });
  });

  it('logs judged: false when the judge failed and the first draft in writer order won', async () => {
    const h = setup({ judgeLevels: [] });

    const result = await h.run({ dryRun: true });

    expect(result.record).toMatchObject({ status: 'dry-run', winner: WRITER_A });
    expect(winnerLine(h)).toMatchObject({ writer: WRITER_A, judged: false });
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: 'judge failed, using the first draft in writer order',
      }),
    );
  });

  it('logs judged: false when there is no judge', async () => {
    const h = setup({ profile: { ...PROFILE, judge: null } });

    await h.run({ dryRun: true });

    expect(winnerLine(h)).toMatchObject({ writer: WRITER_A, judged: false });
  });
});

describe('runDigest: the abort signal (F46)', () => {
  it('ends failed with a clear error, running nothing, when the signal fired before the run', async () => {
    const h = setup();
    const controller = new AbortController();
    controller.abort(new Error('scheduler timeout after 2h'));

    const result = await h.run({ signal: controller.signal });

    expect(result.exitCode).toBe(ExitCode.Failed);
    expect(result.record.status).toBe('failed');
    expect(result.record.error?.message).toBe('Run aborted: scheduler timeout after 2h');
    expectValidRecord(result.record);
    expect(h.store.records.get(WEEK)).toEqual(result.record);
    expect(h.fetcher.calls).toEqual([]);
    expect(modelCalls(h)).toBe(0);
    expect(h.store.isLocked).toBe(false);
    expect(sentNotes(h)).toHaveLength(2);
  });

  it('stops within the classify step when the signal fires during it, and keeps the finished steps', async () => {
    const controller = new AbortController();
    const h = setup({
      onClassify: () => {
        controller.abort(new Error('scheduler timeout after 2h'));
      },
    });

    const result = await h.run({ signal: controller.signal });

    expect(result.exitCode).toBe(ExitCode.Failed);
    expect(result.record).toMatchObject({
      status: 'failed',
      error: {
        step: 'classify',
        message: 'Run aborted during the classify step: scheduler timeout after 2h',
      },
      counts: { collected: 5, afterGuardInput: 5 },
    });
    expect(result.record.counts.classified).toBe(0);
    expect(result.record.timings.map((timing) => timing.step)).toEqual([
      'collect',
      'guardInput',
      'classify',
    ]);
    // One decide call started the abort; no second item and no writer followed.
    expect(h.model.decideCalls).toHaveLength(1);
    expect(h.model.generateCalls).toEqual([]);
    expect(h.store.isLocked).toBe(false);
    expect(JSON.parse(h.artifact('error.json') ?? '{}')).toMatchObject({ step: 'classify' });
    for (const delivery of h.deliveries) {
      expect(delivery.failures).toEqual([
        { weekId: WEEK, step: 'classify', message: result.record.error?.message },
      ]);
    }
  });

  it('names the default reason when the signal was aborted without one', async () => {
    const h = setup();
    const controller = new AbortController();
    controller.abort();

    const result = await h.run({ signal: controller.signal });

    expect(result.record.error?.message).toMatch(/^Run aborted: .*abort/i);
  });

  it('names a reason that is not an error', async () => {
    const h = setup();
    const controller = new AbortController();
    controller.abort('shutting down');

    const result = await h.run({ signal: controller.signal });

    expect(result.record.error?.message).toBe('Run aborted: shutting down');
  });

  it('changes nothing for a signal that never fires', async () => {
    const h = setup();

    const result = await h.run({ signal: new AbortController().signal });

    expect(result.record.status).toBe('sent');
    expect(result.exitCode).toBe(ExitCode.Sent);
  });

  it('lets a run that is already delivering finish: the signal is checked between steps', async () => {
    const controller = new AbortController();
    const h = setup();
    const [markdown] = h.deliveries;
    const send = markdown!.sendDigest.bind(markdown);
    vi.spyOn(markdown!, 'sendDigest').mockImplementation(async (message) => {
      controller.abort(new Error('too late'));
      await send(message);
    });

    const result = await h.run({ signal: controller.signal });

    expect(result.record.status).toBe('sent');
    expect(h.deliveries.map((delivery) => delivery.digests.length)).toEqual([1, 1]);
  });

  it('sends no failure note for an aborted dry run, but still records the failure', async () => {
    const h = setup();
    const controller = new AbortController();
    controller.abort(new Error('stop'));

    const result = await h.run({ dryRun: true, signal: controller.signal });

    expect(result.record.status).toBe('failed');
    expect(sentNotes(h)).toEqual([]);
  });

  it('does not start the delivery of a partly delivered week once the signal fired', async () => {
    const h = setup();
    const previous = makeRunRecord({
      runId: WEEK,
      status: 'failed',
      sentUrls: ['https://example.com/runner-1'],
      deliveredTo: ['markdown'],
      error: { step: 'deliver', message: 'Delivery failed on email (SMTP 451)' },
    });
    h.store.records.set(WEEK, previous);
    h.store.artifacts.set(
      `${WEEK}/digest.md`,
      '# Runners\n\n[Source](https://example.com/runner-1)\n',
    );
    const controller = new AbortController();
    controller.abort(new Error('scheduler timeout after 2h'));

    const result = await h.run({ signal: controller.signal });

    expect(result.record).toMatchObject({
      status: 'failed',
      deliveredTo: ['markdown'],
      error: {
        step: 'deliver',
        message: 'Run aborted before the deliver step: scheduler timeout after 2h',
      },
    });
    expect(h.deliveries.map((delivery) => delivery.digests.length)).toEqual([0, 0]);
    expect(modelCalls(h)).toBe(0);
  });
});
