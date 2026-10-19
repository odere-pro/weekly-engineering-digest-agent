// The set-up the end-to-end runDigest tests share: a fake model that answers by role, fake
// sources, guards and channels, and a recording logger and tracer.
import { expect } from 'vitest';
import { runDigest } from '../runDigest';
import { type DigestDeps, type RunOptions } from '../types';
import { type Digest, type Draft, type Item } from '../../domain/schemas';
import { RunRecordSchema, type RunRecord } from '../../store/runRecord';
import { type GuardCheckId } from '../../guards/guardVerdict';
import { QUESTION_IDS } from '../../classify/classifyPrompt';
import { JUDGE_CRITERIA } from '../../select/judgePrompt';
import { requiredModels, type ModelProfile } from '../../config/profiles';
import type { ConfigInput } from '../../config/schema';
import type { OutputGuard } from '../../guards/Guard';
import type { DecisionAnswer, ModelHealth } from '../../models/ModelProvider';
import type { ArtifactName } from '../../store/RunStore';
import type { LogFields, Logger, Tracer } from '../../shared/telemetry';
import { DATA_OPEN } from '../../shared/untrusted';
import { makeConfig, makeItem } from '../../../test/builders';
import {
  CapturingDelivery,
  FakeInputGuard,
  FakeModelProvider,
  FakeOutputGuard,
  FakeSourceFetcher,
  MemoryRunStore,
  fixedClock,
} from '../../../test/fakes';

export const WEEK = '2026-W42';
export const NOW = '2026-10-16T08:00:00Z';
export const PUBLISHED = '2026-10-14T09:00:00Z';
export const AREA = 'AI models and tooling';
export const WRITER_A = 'writer-a:31b';
export const WRITER_B = 'writer-b:30b';
export const ALL_STEPS = [
  'collect',
  'guardInput',
  'classify',
  'process',
  'write',
  'guardOutput',
  'select',
];

export const PROFILE: ModelProfile = {
  name: 'quality',
  classify: 'classifier:2b',
  guardPolicy: 'policy:2b',
  guardRisk: 'risk:8b',
  writers: [WRITER_A, WRITER_B],
  judge: 'judge:9b',
  requiresAppleSilicon: false,
  minOllamaVersion: '0.0.0',
};

export type DigestBody = Omit<Digest, 'weekId'>;

export interface Scenario {
  items?: readonly Item[];
  failSource?: Error;
  config?: Partial<ConfigInput>;
  profile?: ModelProfile;
  health?: ModelHealth;
  /** Expected relevance level (0-3) per item. */
  relevance?: (item: Item) => number;
  failClassify?: Error;
  /** The digest a writer returns for the items it was given. Throw to fail that writer. */
  draft?: (writer: string, items: readonly Item[]) => DigestBody;
  /** Judge level (0-4) per judge call, in call order; a missing level breaks the judge. */
  judgeLevels?: readonly number[];
  flagOutput?: (draft: Draft) => boolean;
  omitGuards?: readonly GuardCheckId[];
  outputGuards?: readonly OutputGuard[];
}

export interface LogLine {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  fields: LogFields;
}

export function recordingLogger(lines: LogLine[], bound: LogFields = {}): Logger {
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

export function healthyFor(profile: ModelProfile): ModelHealth {
  const models = requiredModels(profile).map((name) => ({ name, capabilities: [] }));
  return { reachable: true, version: '0.40.4', models };
}

export function weekItems(count: number): Item[] {
  return Array.from({ length: count }, (_, index) =>
    makeItem({ title: `Runner ${index + 1}.0 ships`, publishedAt: PUBLISHED }),
  );
}

export function defaultBody(items: readonly Item[]): DigestBody {
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

export function scoreAnswer(level: number, top: number): DecisionAnswer {
  return { type: 'score', level, score: level / top, probabilities: {}, confidence: 0.9 };
}

export function classifyAnswers(level: number): Record<string, DecisionAnswer> {
  return {
    [QUESTION_IDS.relevance]: scoreAnswer(level, 3),
    [QUESTION_IDS.area]: { type: 'choice', choice: AREA, probabilities: {}, confidence: 0.9 },
    [QUESTION_IDS.hype]: { type: 'yesno', probability: 0.1 },
    [QUESTION_IDS.minorRelease]: { type: 'yesno', probability: 0.1 },
  };
}

export function judgeAnswers(level: number | undefined): Record<string, DecisionAnswer> {
  if (level === undefined) return {};
  return Object.fromEntries(JUDGE_CRITERIA.map((criterion) => [criterion, scoreAnswer(level, 4)]));
}

export const inPrompt = (text: string, items: readonly Item[]): Item[] =>
  items.filter((item) => text.includes(`${DATA_OPEN} ${item.id}>>>`));

export function setup(scenario: Scenario = {}) {
  const items = scenario.items ?? weekItems(5);
  const profile = scenario.profile ?? PROFILE;
  const timeline: string[] = [];
  const logs: LogLine[] = [];
  const spans: string[] = [];
  let judgeCalls = 0;

  const model = new FakeModelProvider({
    health: scenario.health ?? healthyFor(profile),
    decide: (request) => {
      timeline.push(request.role);
      if (request.role === 'judge')
        return judgeAnswers(scenario.judgeLevels ? scenario.judgeLevels[judgeCalls++] : 3);
      if (scenario.failClassify) throw scenario.failClassify;
      const [item] = inPrompt(request.state, items);
      return classifyAnswers(item && scenario.relevance ? scenario.relevance(item) : 2.5);
    },
    generate: (request) => {
      const writer = request.model ?? 'unknown';
      timeline.push(`write:${writer}`);
      const given = inPrompt(request.prompt, items);
      return JSON.stringify(scenario.draft ? scenario.draft(writer, given) : defaultBody(given));
    },
  });
  const guardFlag =
    <T>(id: GuardCheckId, flag: (subject: T) => boolean = () => false) =>
    (subject: T): boolean => {
      timeline.push(`guard:${id}`);
      return flag(subject);
    };
  const keep = <T extends { id: GuardCheckId }>(guards: T[]): T[] =>
    guards.filter((guard) => !scenario.omitGuards?.includes(guard.id));
  const outputGuards = keep([
    new FakeOutputGuard(
      'graniteGroundedness',
      guardFlag('graniteGroundedness', scenario.flagOutput),
    ),
    new FakeOutputGuard('clefRubric', guardFlag('clefRubric')),
  ]);
  const fetcher = new FakeSourceFetcher('rss', {
    'example-feed': scenario.failSource ?? [...items],
  });
  const store = new MemoryRunStore();
  const deliveries = [new CapturingDelivery('markdown'), new CapturingDelivery('email')];
  const tracer: Tracer = {
    span: (name, _attributes, fn) => {
      spans.push(name);
      return fn();
    },
  };
  const deps: DigestDeps = {
    config: makeConfig({ focusAreas: [AREA, 'Platform engineering'], ...scenario.config }),
    profile,
    model,
    fetchers: { rss: fetcher },
    inputGuards: keep([
      new FakeInputGuard('ruleInjection'),
      new FakeInputGuard('clefPolicy', guardFlag('clefPolicy')),
      new FakeInputGuard('graniteRisk', guardFlag('graniteRisk')),
    ]),
    outputGuards: scenario.outputGuards ?? outputGuards,
    deliveries,
    store,
    logger: recordingLogger(logs),
    tracer,
    clock: fixedClock(NOW),
  };
  const run = (options: RunOptions = {}) => runDigest(deps, options);
  const artifact = (name: ArtifactName) => store.artifacts.get(`${WEEK}/${name}`);
  const seen = { timeline, logs, spans };
  return { deps, run, artifact, items, model, store, fetcher, deliveries, outputGuards, ...seen };
}

export function expectValidRecord(record: RunRecord): void {
  expect(RunRecordSchema.parse(record)).toEqual(record);
}

export const sentDigests = (h: ReturnType<typeof setup>) => h.deliveries.flatMap((d) => d.digests);
export const sentNotes = (h: ReturnType<typeof setup>) => h.deliveries.flatMap((d) => d.failures);
export const decideCalls = (h: ReturnType<typeof setup>, role: string) =>
  h.model.decideCalls.filter((call) => call.role === role);
