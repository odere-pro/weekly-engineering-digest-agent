// Shared wiring for the resilience integration tests (W2-04). The run store is the real
// createFsRunStore in a temp dir; models, feeds, guards and delivery are fakes. The chain, the
// steps, the checks, the render and the step loop are the real ones.
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach } from 'vitest';
import { createOllamaProvider } from '../../src/models/adapters/ollama';
import { createFsRunStore } from '../../src/store/adapters/fsRunStore';
import type { AppHandle } from '../../src/app/container';
import { runCommand, type RunCommandOptions } from '../../src/cli/run/run';
import { PROFILES, requiredModels } from '../../src/config/profiles';
import { QUESTION_IDS } from '../../src/classify/classifyPrompt';
import { JUDGE_CRITERIA } from '../../src/select/judgePrompt';
import type { DigestDeps } from '../../src/digest/runDigest';
import { RunRecordSchema, type RunRecord } from '../../src/store/runRecord';
import { type Item } from '../../src/domain/schemas';
import { type Role } from '../../src/models/roles';
import type {
  DecideRequest,
  DecisionAnswer,
  GenerateRequest,
  ModelHealth,
  ModelProvider,
} from '../../src/models/ModelProvider';
import type { OutputGuard } from '../../src/guards/Guard';
import type { RunStore } from '../../src/store/RunStore';
import type { Clock } from '../../src/shared/clock';
import type { LogFields, Logger } from '../../src/shared/telemetry';
import { DATA_OPEN } from '../../src/shared/untrusted';
import { makeConfig, makeItem } from '../builders';
import { fakeOllama, type FakeOllama, type OllamaCall, type OllamaRoute } from './fakeOllama';
import {
  CapturingDelivery,
  FakeInputGuard,
  FakeModelProvider,
  FakeOutputGuard,
  FakeSourceFetcher,
  fixedClock,
  noopTracer,
} from '../fakes';

export const MODELS_AREA = 'AI models and tooling';
export const PLATFORM_AREA = 'Platform engineering';
export const PROFILE = PROFILES.quality;

function writerAt(index: number): string {
  const writer = PROFILE.writers[index];
  if (writer === undefined) throw new Error(`The ${PROFILE.name} profile has no writer ${index}`);
  return writer;
}
export const FIRST_WRITER = writerAt(0);
export const SECOND_WRITER = writerAt(1);
export const OLLAMA_URL = 'http://localhost:11434';

/** A Friday in ISO week 2026-W42 (Europe/Berlin), after Monday's 07:45 slot. */
export const FRIDAY = '2026-10-16T05:45:00Z';
export const WEEK = '2026-W42';
export const LOCK_FILE = 'digest.lock';

/** Generous for a real 1 s retry backoff or a 1.5 s feed backoff on a loaded machine. */
export const TEST_TIMEOUT_MS = 15_000;
const HOUR_MS = 3_600_000;
const RELEVANT = 2.4;

const relevantAnswer: DecisionAnswer = {
  type: 'score',
  level: RELEVANT,
  score: 0.8,
  probabilities: {},
  confidence: 0.9,
};
/** Below the default relevance threshold of 1.5. */
export const IRRELEVANT_ANSWER: DecisionAnswer = {
  type: 'score',
  level: 0.2,
  score: 0.07,
  probabilities: {},
  confidence: 0.9,
};

interface FeedItems {
  rss: Item[];
  github: Item[];
}

/**
 * Four items inside the window, one patch release (dropped as minor) and one that is too old.
 * URLs are fixed, as a real feed's are, so every world (process) sees the same items.
 */
function feedItems(now: Date): FeedItems {
  const ago = (hours: number): string => new Date(now.getTime() - hours * HOUR_MS).toISOString();
  return {
    rss: [
      makeItem({
        sourceId: 'model-blog',
        url: 'https://example.com/posts/gemma-4',
        title: 'Gemma 4 adds tool calling',
        publishedAt: ago(72),
      }),
      makeItem({
        sourceId: 'model-blog',
        url: 'https://example.com/posts/model-router-2',
        title: 'Model router 2.0',
        publishedAt: ago(48),
      }),
      makeItem({
        sourceId: 'model-blog',
        url: 'https://example.com/posts/old-news',
        title: 'Old news',
        publishedAt: ago(24 * 40),
      }),
    ],
    github: [
      makeItem({
        sourceId: 'runner',
        kind: 'github',
        url: 'https://github.com/example/runner/releases/tag/v3.0.0',
        title: 'runner v3.0.0',
        publishedAt: ago(24),
      }),
      makeItem({
        sourceId: 'runner',
        kind: 'github',
        url: 'https://github.com/example/runner/releases/tag/v2.9.1',
        title: 'runner v2.9.1',
        publishedAt: ago(96),
      }),
    ],
  };
}

function itemsIn(items: readonly Item[], text: string): Item[] {
  return items.filter((item) => text.includes(`${DATA_OPEN} ${item.id}>>>`));
}

/** Decision model: the patch release is minor, everything else is relevant and calm. */
function defaultAnswers(
  items: readonly Item[],
  request: DecideRequest,
): Record<string, DecisionAnswer> {
  if (request.role === 'judge') {
    return Object.fromEntries(JUDGE_CRITERIA.map((criterion) => [criterion, relevantAnswer]));
  }
  const [item] = itemsIn(items, request.state);
  const area = item?.kind === 'github' ? PLATFORM_AREA : MODELS_AREA;
  return {
    [QUESTION_IDS.relevance]: relevantAnswer,
    [QUESTION_IDS.area]: { type: 'choice', choice: area, probabilities: {}, confidence: 0.85 },
    [QUESTION_IDS.hype]: { type: 'yesno', probability: 0.05 },
    [QUESTION_IDS.minorRelease]: {
      type: 'yesno',
      probability: item?.title.endsWith('.1') ? 0.9 : 0.1,
    },
  };
}

/** A valid digest over the items named in `prompt`, as the model's JSON reply. */
function validDigest(items: readonly Item[], prompt: string): string {
  return JSON.stringify({
    headline: 'This week: tool calling and faster runners',
    intro: 'Three releases worth your time.',
    items: itemsIn(items, prompt).map((item) => ({
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

export interface LogLine {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly message: string;
  readonly fields: LogFields;
}

/** Keeps every line, with the fields of the child loggers it passed through. */
function recordingLogger(): { logger: Logger; lines: LogLine[] } {
  const lines: LogLine[] = [];
  const make = (bound: LogFields): Logger => {
    const write =
      (level: LogLine['level']) =>
      (message: string, fields: LogFields = {}): void => {
        lines.push({ level, message, fields: { ...bound, ...fields } });
      };
    return {
      debug: write('debug'),
      info: write('info'),
      warn: write('warn'),
      error: write('error'),
      child: (fields) => make({ ...bound, ...fields }),
    };
  };
  return { logger: make({}), lines };
}

/** What a test can hand the model factory to build a provider around the fake one. */
export interface ModelParts {
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

export interface OllamaWorldOptions extends Omit<WorldOptions, 'model'> {
  /** Answers /api/chat; `validReply` builds the valid digest JSON for a write prompt. */
  chat?: (call: OllamaCall, validReply: (prompt: string) => string) => Response | Promise<Response>;
  systemone?: OllamaRoute;
  /** Tags /api/tags lists; default is every model of the profile. */
  models?: readonly string[];
  /** An Ollama that refuses every connection. */
  down?: Error;
  /** Per-attempt timeouts of the real adapter, in ms. */
  timeoutsMs?: Partial<Record<Role, number>>;
  retries?: number;
  /**
   * The real adapter serves generate and health; decisions stay on the fake model (default).
   * Set false to send decisions to the scripted /v1/systemone as well.
   */
  decideOnFake?: boolean;
}

/** A world whose model is the real Ollama adapter, talking to a scripted Ollama. */
export function createOllamaWorld(options: OllamaWorldOptions): {
  world: World;
  ollama: FakeOllama;
} {
  const {
    chat,
    systemone,
    models,
    down,
    timeoutsMs,
    retries,
    decideOnFake = true,
    ...worldOptions
  } = options;
  let ollama: FakeOllama | undefined;
  const world = createWorld({
    ...worldOptions,
    model: ({ fake, logger, validReply }) => {
      ollama = fakeOllama({
        down,
        models,
        systemone,
        chat: chat && ((call) => chat(call, validReply)),
      });
      const real = createOllamaProvider({
        baseUrl: OLLAMA_URL,
        profile: PROFILE,
        fetch: ollama.fetch,
        timeoutsMs,
        retries,
        logger,
      });
      if (!decideOnFake) return real;
      return {
        generate: (request) => real.generate(request),
        health: () => real.health(),
        decide: (request) => fake.decide(request),
      };
    },
  });
  if (!ollama) throw new Error('createWorld did not build the model');
  return { world, ollama };
}

// ---------------------------------------------------------------------------------------------
// Disk

/**
 * A fresh data dir for each test, removed afterwards. Call it once at the top of a test file
 * (or a `describe`) and read the path inside a test; reading it earlier throws.
 */
export function useDataDir(): () => string {
  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'digest-int-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return () => {
    if (dir === '') throw new Error('The data dir exists only while a test runs');
    return dir;
  };
}

export function runFile(dataDir: string, weekId: string, name: string): string {
  return join(dataDir, 'runs', weekId, name);
}

function isNoEntry(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isNoEntry(error)) return undefined;
    throw error;
  }
}

/** The week's run.json as the run store wrote it, parsed with the real schema. */
export async function readRunJson(dataDir: string, weekId: string): Promise<RunRecord> {
  const text = await readTextIfExists(runFile(dataDir, weekId, 'run.json'));
  if (text === undefined) throw new Error(`No run.json for ${weekId} under ${dataDir}`);
  return RunRecordSchema.parse(JSON.parse(text));
}

export async function lockExists(dataDir: string): Promise<boolean> {
  return (await readTextIfExists(join(dataDir, LOCK_FILE))) !== undefined;
}

export interface LockContents {
  pid: number;
  runId: string;
  startedAt: string;
}

export async function writeLock(dataDir: string, lock: LockContents | string): Promise<void> {
  const text = typeof lock === 'string' ? lock : JSON.stringify(lock);
  await writeFile(join(dataDir, LOCK_FILE), text);
}

/** The pid of a process that has already exited. */
export function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '']);
  if (child.error) throw child.error;
  return child.pid;
}

// ---------------------------------------------------------------------------------------------
// CLI

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** `digest run` over the world's deps, with the real runDigest, for the exit code and the message. */
export async function runCli(world: World, options: RunCommandOptions = {}): Promise<CliResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const app: AppHandle = { deps: world.deps, close: () => Promise.resolve() };
  const exitCode = await runCommand(options, {
    loadConfig: () =>
      Promise.resolve({
        config: world.deps.config,
        env: { OLLAMA_URL, LOG_LEVEL: 'info' },
        secrets: {},
        profile: PROFILE,
        platform: { os: 'darwin', arch: 'arm64' },
        configPath: join(world.dataDir, 'digest.config.json'),
      }),
    buildApp: () => Promise.resolve(app),
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  });
  return { exitCode, stdout: stdout.join(''), stderr: stderr.join('') };
}
