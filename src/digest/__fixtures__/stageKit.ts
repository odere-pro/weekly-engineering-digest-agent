// The set-up the chain, stage and record tests share: a run context over fakes, a logger that
// keeps its lines, and builders for the chain state a stage starts from. No stage runs here.
import type { ScoredItem } from '../../classify/classification';
import type { ModelProfile } from '../../config/profiles';
import type { ConfigInput } from '../../config/schema';
import type { Delivery } from '../../delivery/Delivery';
import type { Digest, Item } from '../../domain/schemas';
import type { GuardCheckId } from '../../guards/guardVerdict';
import type { InputGuard, OutputGuard } from '../../guards/Guard';
import type { ModelProvider } from '../../models/ModelProvider';
import type { SourceFetcher } from '../../sources/SourceFetcher';
import type { LogFields, Logger } from '../../shared/telemetry';
import type { CheckedDraft } from '../../write/write';
import { makeConfig, makeDraft, makeItem, makeScoredItem } from '../../../test/builders';
import {
  CapturingDelivery,
  FakeInputGuard,
  FakeModelProvider,
  FakeOutputGuard,
  FakeSourceFetcher,
  MemoryRunStore,
  fixedClock,
} from '../../../test/fakes';
import type { RunContext } from '../chain/runContext';
import { EMPTY_STATE, type ChainState } from '../chain/state';
import type { DigestDeps } from '../types';

export const WEEK = '2026-W42';
export const NOW = '2026-10-16T08:00:00Z';
export const AREA = 'AI models and tooling';
export const WRITER_A = 'writer-a:31b';
export const WRITER_B = 'writer-b:30b';

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

export interface LogLine {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  fields: LogFields;
}

/** Keeps every line; a child logger adds its fields to the lines it writes. */
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

export interface ContextOptions {
  config?: Partial<ConfigInput>;
  profile?: ModelProfile;
  model?: ModelProvider;
  fetchers?: DigestDeps['fetchers'];
  inputGuards?: readonly InputGuard[];
  outputGuards?: readonly OutputGuard[];
  deliveries?: readonly Delivery[];
  store?: MemoryRunStore;
  dryRun?: boolean;
  useFallback?: boolean;
  holdArtifacts?: boolean;
  disabledGuards?: readonly GuardCheckId[];
  signal?: AbortSignal;
  sinceDays?: number;
  sampling?: DigestDeps['sampling'];
}

/** A run context at `NOW` for `WEEK`, with fakes for everything it reaches. */
export function contextFor(options: ContextOptions = {}) {
  const logs: LogLine[] = [];
  const logger = recordingLogger(logs, { runId: WEEK });
  const store = options.store ?? new MemoryRunStore();
  const deliveries = options.deliveries ?? [
    new CapturingDelivery('markdown'),
    new CapturingDelivery('email'),
  ];
  const model = options.model ?? new FakeModelProvider();
  const spans: string[] = [];
  const deps: DigestDeps = {
    config: makeConfig({ focusAreas: [AREA, 'Platform engineering'], ...options.config }),
    profile: options.profile ?? PROFILE,
    model,
    fetchers: options.fetchers ?? {},
    inputGuards: options.inputGuards ?? [new FakeInputGuard('clefPolicy')],
    outputGuards: options.outputGuards ?? [
      new FakeOutputGuard('graniteGroundedness'),
      new FakeOutputGuard('clefRubric'),
    ],
    deliveries,
    store,
    logger,
    tracer: {
      span: (name, _attributes, fn) => {
        spans.push(name);
        return fn();
      },
    },
    clock: fixedClock(NOW),
    ...(options.sampling && { sampling: options.sampling }),
  };
  const ctx: RunContext = {
    deps,
    weekId: WEEK,
    dryRun: options.dryRun ?? false,
    sinceDays: options.sinceDays ?? 7,
    startedAt: new Date(NOW),
    signal: options.signal,
    notifyFailure: true,
    useFallback: options.useFallback ?? true,
    logger,
    disabledGuards: options.disabledGuards ?? [],
    holdArtifacts: options.holdArtifacts ?? false,
  };
  return { ctx, deps, store, deliveries, model, logs, spans, logger };
}

export function stateOf(overrides: Partial<ChainState> = {}): ChainState {
  return { ...EMPTY_STATE, ...overrides };
}

/** An item the classifier gave `relevance`. */
export function scored(relevance: number, overrides: Partial<Item> = {}): ScoredItem {
  return makeScoredItem(
    { publishedAt: '2026-10-14T09:00:00Z', ...overrides },
    { relevance, area: AREA },
  );
}

export function fetcherOf(items: readonly Item[] | Error, id = 'example-feed'): SourceFetcher {
  return new FakeSourceFetcher('rss', { [id]: items instanceof Error ? items : [...items] });
}

/** A writer's draft over `items` with the Markdown that was checked. */
export function checkedDraft(
  items: readonly Item[],
  writer = WRITER_A,
  overrides: Partial<Digest> = {},
): CheckedDraft {
  return { draft: makeDraft(items, writer, overrides), markdown: `# ${writer} digest\n` };
}

export { makeItem };
