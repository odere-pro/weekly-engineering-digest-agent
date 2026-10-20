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
import type { RunRecord } from '../../store/runRecord';
import type { LogFields, Logger } from '../../shared/telemetry';
import type { CheckedDraft } from '../../write/checkedStep/types';
import { makeConfig, makeDraft, makeScoredItem } from '../../../test/builders';
import {
  CapturingDelivery,
  FakeInputGuard,
  FakeModelProvider,
  FakeOutputGuard,
  MemoryRunStore,
  fixedClock,
} from '../../../test/fakes';
import { holdingLock, type RunContext } from '../chain/runContext';
import { lockLostReason } from '../../store/lockLost';
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

interface LogLine {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  fields: LogFields;
}

/** Keeps every line; a child logger adds its fields to the lines it writes. */
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
  /** The week's record when the run began; see `RunContext.previousRecord`. */
  previousRecord?: RunRecord;
  /** See `RunContext.lastDelivered`. */
  lastDelivered?: RunRecord;
  disabledGuards?: readonly GuardCheckId[];
  signal?: AbortSignal;
  /** The lock's `lost`; the run signal then fires with it, as it does under `runDigest`. */
  lockLost?: AbortSignal;
  sinceDays?: number;
  reuse?: RunContext['reuse'];
  variant?: RunContext['variant'];
  sampling?: DigestDeps['sampling'];
}

/** The `lost` of a lock that another run has taken over. */
export function lostLock(): AbortSignal {
  const lock = new AbortController();
  lock.abort(lockLostReason());
  return lock.signal;
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
  const base: RunContext = {
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
    previousRecord: options.previousRecord,
    lastDelivered: options.lastDelivered,
    ...(options.reuse && { reuse: options.reuse }),
    ...(options.variant && { variant: options.variant }),
  };
  const ctx = options.lockLost ? holdingLock(base, options.lockLost) : base;
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

/** A writer's draft over `items` with the Markdown that was checked. */
export function checkedDraft(
  items: readonly Item[],
  writer = WRITER_A,
  overrides: Partial<Digest> = {},
): CheckedDraft {
  return { draft: makeDraft(items, writer, overrides), markdown: `# ${writer} digest\n` };
}
