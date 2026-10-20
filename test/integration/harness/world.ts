import { requiredModels } from '../../../src/config/profiles';
import type { DigestDeps } from '../../../src/digest/types';
import type { Item } from '../../../src/domain/schemas';
import type {
  DecideRequest,
  DecisionAnswer,
  GenerateRequest,
  ModelHealth,
  ModelProvider,
} from '../../../src/models/ModelProvider';
import type { OutputGuard } from '../../../src/guards/Guard';
import type { RunStore } from '../../../src/store/RunStore';
import { createFsRunStore } from '../../../src/store/adapters/fsRunStore';
import type { Clock } from '../../../src/shared/clock';
import type { Logger } from '../../../src/shared/telemetry';
import { makeConfig } from '../../builders';
import {
  CapturingDelivery,
  FakeInputGuard,
  FakeModelProvider,
  FakeOutputGuard,
  FakeSourceFetcher,
  fixedClock,
  noopTracer,
} from '../../fakes';
import { defaultAnswers } from './answers';
import { MODELS_AREA, PLATFORM_AREA, PROFILE } from './constants';
import { feedItems } from './feedItems';
import { recordingLogger, type LogLine } from './recordingLogger';
import { validDigest } from './validDigest';

/** What a test can hand the model factory to build a provider around the fake one. */
interface ModelParts {
  readonly fake: FakeModelProvider;
  readonly logger: Logger;
  /** The valid digest JSON for a write prompt. */
  readonly validReply: (prompt: string) => string;
}

export interface WorldOptions {
  /** The clock's start, an ISO instant. Feed items are dated relative to it. */
  now: string;
  dataDir: string;
  /** Replaces the clock, for tests that move time. */
  clock?: Clock;
  /** Feed results by source id; an Error makes the source fail. Merged over the defaults. */
  feeds?: Readonly<Record<string, Item[] | Error>>;
  decide?: (
    request: DecideRequest,
    valid: () => Record<string, DecisionAnswer>,
  ) => Record<string, DecisionAnswer>;
  /** `valid()` is the digest for this request's prompt; `validFor` builds one for another prompt. */
  generate?: (
    request: GenerateRequest,
    valid: () => string,
    validFor: (prompt: string) => string,
  ) => string;
  health?: ModelHealth;
  /** Builds the provider the run uses; the default is the fake one. */
  model?: (parts: ModelParts) => ModelProvider;
  outputGuards?: readonly OutputGuard[];
}

export interface World {
  readonly deps: DigestDeps;
  readonly store: RunStore;
  readonly dataDir: string;
  readonly deliveries: readonly CapturingDelivery[];
  readonly fake: FakeModelProvider;
  readonly rss: FakeSourceFetcher;
  readonly github: FakeSourceFetcher;
  readonly logs: readonly LogLine[];
}

const SOURCES = [
  { id: 'model-blog', kind: 'rss', url: 'https://example.com/feed.xml' },
  { id: 'runner', kind: 'github', url: 'https://github.com/example/runner' },
  { id: 'broken-feed', kind: 'rss', url: 'https://example.org/feed.xml' },
] as const;

function fakeModel(
  options: WorldOptions,
  items: readonly Item[],
  validReply: (prompt: string) => string,
): FakeModelProvider {
  return new FakeModelProvider({
    decide: (request) => {
      const valid = (): Record<string, DecisionAnswer> => defaultAnswers(items, request);
      return options.decide ? options.decide(request, valid) : valid();
    },
    generate: (request) => {
      const valid = (): string => validReply(request.prompt);
      return options.generate ? options.generate(request, valid, validReply) : valid();
    },
    health: options.health ?? {
      reachable: true,
      version: '0.40.4',
      models: requiredModels(PROFILE).map((name) => ({ name, capabilities: ['completion'] })),
    },
  });
}

/** One run's worth of dependencies: the real fs store over `dataDir`, fakes for the rest. */
export function createWorld(options: WorldOptions): World {
  const clock = options.clock ?? fixedClock(options.now);
  const feeds = feedItems(new Date(options.now));
  const allItems = [...feeds.rss, ...feeds.github];
  const { logger, lines } = recordingLogger();
  const bySource = {
    'model-blog': feeds.rss,
    runner: feeds.github,
    'broken-feed': [],
    ...options.feeds,
  };
  const validReply = (prompt: string): string => validDigest(allItems, prompt);
  const fake = fakeModel(options, allItems, validReply);
  const rss = new FakeSourceFetcher('rss', bySource);
  const github = new FakeSourceFetcher('github', bySource);
  const store = createFsRunStore({ dataDir: options.dataDir, clock, logger });
  const deliveries = [
    new CapturingDelivery('markdown'),
    new CapturingDelivery('email'),
    new CapturingDelivery('slack'),
  ];
  const deps: DigestDeps = {
    config: makeConfig({
      dataDir: options.dataDir,
      focusAreas: [MODELS_AREA, PLATFORM_AREA],
      sources: SOURCES.map((source) => ({ ...source })),
    }),
    profile: PROFILE,
    model: options.model?.({ fake, logger, validReply }) ?? fake,
    fetchers: { rss, github },
    inputGuards: [new FakeInputGuard('clefPolicy'), new FakeInputGuard('graniteRisk')],
    outputGuards: options.outputGuards ?? [
      new FakeOutputGuard('graniteGroundedness'),
      new FakeOutputGuard('clefRubric'),
    ],
    deliveries,
    store,
    logger,
    tracer: noopTracer,
    clock,
  };
  return { deps, store, dataDir: options.dataDir, deliveries, fake, rss, github, logs: lines };
}

/** The same world with another model provider; the store, deliveries and fetchers stay shared. */
export function withModel(world: World, model: ModelProvider): DigestDeps {
  return { ...world.deps, model };
}
