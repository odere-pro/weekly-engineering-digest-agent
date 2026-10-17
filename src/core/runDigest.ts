import type { Config } from '../config/schema.js';
import { modelsByRole, modelsInUse, type ModelProfile } from '../config/profiles.js';
import type { Delivery, FailureNote } from '../ports/Delivery.js';
import type { InputGuard, OutputGuard } from '../ports/Guard.js';
import type { ModelHealth, ModelProvider } from '../ports/ModelProvider.js';
import type { ArtifactName, RunLock, RunStore } from '../ports/RunStore.js';
import type { SourceFetcher } from '../ports/SourceFetcher.js';
import type { Clock } from '../shared/clock.js';
import { DigestError, errorMessage } from '../shared/errors.js';
import { isoWeekId } from '../shared/isoWeek.js';
import { noopLogger, type Logger, type Tracer } from '../shared/telemetry.js';
import { DIGEST_MIN_ITEMS } from './checks/formatCheck.js';
import {
  abortedError,
  digestMessage,
  endRun,
  failureNote,
  reachedAChannel,
  recordError,
  shipDigest,
  toJson,
  type Failure,
  type HeldArtifact,
} from './runEnding.js';
import { loadPartDelivery, resumeDelivery, type PartDelivery } from './runResume.js';
import {
  WEEK_ID_PATTERN,
  exitCodeFor,
  type DeliveryId,
  type DraftOutcome,
  type ExitCode,
  type GuardCheckId,
  type Item,
  type JudgeScore,
  type RunRecord,
  type RunStatus,
  type ScoredItem,
  type SourceKind,
  type StepName,
} from './schemas.js';
import { classifyStep } from './steps/classify.js';
import { collectStep } from './steps/collect.js';
import { guardInputStep } from './steps/guardInput.js';
import { guardOutputStep } from './steps/guardOutput.js';
import { flaggedBy, planGuards } from './steps/guardRun.js';
import { processStep } from './steps/process.js';
import { selectStep, type SelectOutput } from './steps/select.js';
import { writeCheckedStep, type CheckedDraft, type CodeChecked } from './steps/write.js';
import { runWorkflow, type WorkflowStep } from './workflow.js';

/** Everything the core needs; every entry point wires real or fake implementations. */
export interface DigestDeps {
  config: Config;
  profile: ModelProfile;
  model: ModelProvider;
  fetchers: Readonly<Partial<Record<SourceKind, SourceFetcher>>>;
  inputGuards: readonly InputGuard[];
  outputGuards: readonly OutputGuard[];
  deliveries: readonly Delivery[];
  store: RunStore;
  logger: Logger;
  tracer: Tracer;
  clock: Clock;
}

export interface RunOptions {
  /** Window in days; defaults to config.windowDays. */
  sinceDays?: number;
  /** Write the digest to disk and send nothing. */
  dryRun?: boolean;
  /** Run even if the week already has a sent digest. */
  force?: boolean;
  /** Override the ISO week (evals, catch-up). */
  weekId?: string;
  /**
   * Ends the run `failed`, releasing the lock, once it has fired. Checked before each step and
   * before a resume's delivery, never inside one: a step that is running finishes first. The
   * reason goes into run.json and the failure note as given, so the caller must compose it
   * (a timeout message), never copy model or feed text into it.
   */
  signal?: AbortSignal;
}

export interface RunResult {
  record: RunRecord;
  exitCode: ExitCode;
  /** The digest.md this run wrote or, on a resume, sent. None when no digest was made, or when
   * the week's earlier files stayed (`RunContext.holdArtifacts`). */
  markdown?: string;
}

const WORKFLOW_ID = 'digest';
const DAY_MS = 86_400_000;
const WRITE_FAILED = 'write';

/** One run's fixed inputs, resolved before anything runs. */
interface RunContext {
  readonly deps: DigestDeps;
  readonly weekId: string;
  readonly dryRun: boolean;
  readonly sinceDays: number;
  readonly startedAt: Date;
  readonly signal?: AbortSignal;
  /** Bound to the run id. */
  readonly logger: Logger;
  /** Input then output checks that are off this run, in config order. */
  readonly disabledGuards: readonly GuardCheckId[];
  /**
   * The week's earlier record reached a channel, and the files it left are what a resume sends.
   * This run then holds its files in the chain state; `endRun` writes them if its record is saved.
   */
  readonly holdArtifacts: boolean;
}

/** Ends the run early with this status; the remaining steps are skipped. */
interface Settled {
  readonly status: 'quiet' | 'blocked';
  /** The step that settled the run. `timed` stamps it, so a note always names the right one. */
  readonly step?: StepName;
  /** Sent as a failure note; none for an ordinary quiet week. */
  readonly note?: string;
}

/** What the chain has produced so far. Every step returns a new state. */
interface ChainState {
  readonly collected: readonly Item[];
  readonly failedSources: RunRecord['failedSources'];
  readonly kept: readonly Item[];
  readonly scored: readonly ScoredItem[];
  /** Items that passed the process filters, before the top N cut. Unset until that step ran. */
  readonly afterProcess?: number;
  readonly selected: readonly ScoredItem[];
  /** The drafts after the writers' retry, each with its link and format check. */
  readonly checked: readonly CodeChecked[];
  readonly drafts: readonly DraftOutcome[];
  readonly passed: readonly CheckedDraft[];
  readonly winner?: CheckedDraft;
  readonly sentUrls: readonly string[];
  /** Channels that took the digest, in the order they took it. */
  readonly deliveredTo: readonly DeliveryId[];
  readonly timings: RunRecord['timings'];
  /** Files built but not written; see `RunContext.holdArtifacts`. */
  readonly held: readonly HeldArtifact[];
  readonly settled?: Settled;
}

interface ChainOutcome {
  readonly state: ChainState;
  readonly failure?: Failure;
}

const EMPTY_STATE: ChainState = {
  collected: [],
  failedSources: [],
  kept: [],
  scored: [],
  selected: [],
  checked: [],
  drafts: [],
  passed: [],
  sentUrls: [],
  deliveredTo: [],
  timings: [],
  held: [],
};

/** Carries the state the failed step started from, so the record keeps what ran before it. */
class StepFailure extends Error {
  constructor(
    readonly step: StepName,
    readonly state: ChainState,
    cause: unknown,
  ) {
    super(errorMessage(cause), { cause });
    this.name = 'StepFailure';
  }
}

/** Thrown by a step that fails after part of its work, so the record keeps that part. */
class PartialFailure extends Error {
  constructor(
    readonly state: ChainState,
    cause: unknown,
  ) {
    super(errorMessage(cause), { cause });
    this.name = 'PartialFailure';
  }
}

/**
 * The whole chain: collect, guard-input, classify, process, write, guard-output, select, deliver
 * (W2-01). A rerun of a partly delivered week only finishes the delivery (W2-08).
 */
export async function runDigest(deps: DigestDeps, options: RunOptions = {}): Promise<RunResult> {
  const ctx = runContext(deps, options);
  return deps.tracer.span('runDigest', { runId: ctx.weekId, dryRun: ctx.dryRun }, async () => {
    if (!options.force && (await deps.store.hasSentDigest(ctx.weekId))) return skipped(ctx);
    const lock = await deps.store.acquireLock(ctx.weekId);
    try {
      // Read again under the lock: a run that held it may have just sent this week.
      const previous = await deps.store.getRunRecord(ctx.weekId);
      if (previous?.status === 'sent' && !options.force) return skipped(ctx);
      const part = options.force || ctx.dryRun ? undefined : await loadPartDelivery(ctx, previous);
      if (part) return await resumed(ctx, part);
      const chainCtx = { ...ctx, holdArtifacts: reachedAChannel(previous) };
      return await finish(chainCtx, await runChain(chainCtx), previous);
    } finally {
      await releaseLock(ctx, lock);
    }
  });
}

/** Saves nothing: the week's sent record stays as it is. */
function skipped(ctx: RunContext): RunResult {
  ctx.logger.info('Week already has a sent digest; skipped (use --force to run it again)');
  const record = buildRecord(ctx, { state: EMPTY_STATE }, 'skipped', ctx.deps.clock.now());
  return { record, exitCode: exitCodeFor('skipped') };
}

function runContext(deps: DigestDeps, options: RunOptions): RunContext {
  const startedAt = deps.clock.now();
  const weekId = options.weekId ?? isoWeekId(startedAt, deps.config.schedule.timeZone);
  const sinceDays = options.sinceDays ?? deps.config.windowDays;
  if (!WEEK_ID_PATTERN.test(weekId)) {
    throw new DigestError(`Invalid ISO week id "${weekId}"; expected one like 2026-W43`);
  }
  if (!Number.isInteger(sinceDays) || sinceDays < 1) {
    throw new DigestError(
      `The window must be a whole number of days, at least 1; got ${sinceDays}`,
    );
  }
  return {
    deps,
    weekId,
    startedAt,
    sinceDays,
    dryRun: options.dryRun ?? false,
    signal: options.signal,
    logger: deps.logger.child({ runId: weekId }),
    disabledGuards: plannedDisabledGuards(deps),
    holdArtifacts: false,
  };
}

/**
 * Output guards run after the code checks, yet the footer those checks see must already name
 * them. The guard steps plan the same way and log missing guards themselves, so this is silent.
 */
function plannedDisabledGuards(deps: DigestDeps): GuardCheckId[] {
  const { input, output } = deps.config.guards;
  return [
    ...planGuards(input, deps.inputGuards, noopLogger).disabledChecks,
    ...planGuards(output, deps.outputGuards, noopLogger).disabledChecks,
  ];
}

async function releaseLock(ctx: RunContext, lock: RunLock): Promise<void> {
  try {
    await lock.release();
  } catch (error) {
    ctx.logger.error('Could not release the run lock', { error: errorMessage(error) });
  }
}

// ---------------------------------------------------------------------------------------------
// The chain

function runChain(ctx: RunContext): Promise<ChainOutcome> {
  return settle(ctx, async () => {
    const stopped = abortedError(ctx.signal);
    if (stopped) throw stopped;
    await assertModelsReady(ctx);
    return runWorkflow(WORKFLOW_ID, chainSteps(ctx), EMPTY_STATE);
  });
}

/** Never rejects: a failure comes back with the state of the steps that finished before it. */
async function settle(ctx: RunContext, run: () => Promise<ChainState>): Promise<ChainOutcome> {
  try {
    return { state: await run() };
  } catch (error) {
    if (error instanceof StepFailure) {
      return { state: error.state, failure: { error: error.cause, step: error.step } };
    }
    ctx.logger.error('Run failed outside a step', { error: errorMessage(error) });
    return { state: EMPTY_STATE, failure: { error } };
  }
}

function chainSteps(ctx: RunContext): WorkflowStep<ChainState>[] {
  const steps = [
    stage(ctx, 'collect', collect),
    stage(ctx, 'guardInput', guardInput),
    stage(ctx, 'classify', classify),
    stage(ctx, 'process', selectItems),
    stage(ctx, 'write', write),
    stage(ctx, 'guardOutput', checkDrafts),
    stage(ctx, 'select', pickWinner),
  ];
  return ctx.dryRun ? steps : [...steps, stage(ctx, 'deliver', deliver)];
}

type StageFn = (ctx: RunContext, state: ChainState, logger: Logger) => Promise<ChainState>;

/**
 * Skips a settled run; stops one whose signal fired, keeping the steps that finished; otherwise
 * times, traces and logs the step with the run id and step.
 */
function stage(ctx: RunContext, step: StepName, fn: StageFn): WorkflowStep<ChainState> {
  return {
    id: step,
    run: (state) => {
      if (state.settled) return Promise.resolve(state);
      const stopped = abortedError(ctx.signal, step);
      if (!stopped) return timed(ctx, step, state, fn);
      ctx.logger.warn('Run aborted', { step, reason: errorMessage(stopped.cause) });
      return Promise.reject(new StepFailure(step, state, stopped));
    },
  };
}

async function timed(
  ctx: RunContext,
  step: StepName,
  state: ChainState,
  fn: StageFn,
): Promise<ChainState> {
  const { clock, tracer } = ctx.deps;
  const logger = ctx.logger.child({ step });
  const startedMs = clock.now().getTime();
  const timing = () => ({ step, ms: Math.max(0, clock.now().getTime() - startedMs) });
  try {
    const next = await tracer.span(step, { runId: ctx.weekId, step }, () => fn(ctx, state, logger));
    const done = timing();
    logger.info('Step finished', { ms: done.ms });
    const settled = next.settled && { ...next.settled, step };
    return { ...next, ...(settled && { settled }), timings: [...next.timings, done] };
  } catch (error) {
    const failed = timing();
    const partial = error instanceof PartialFailure;
    const cause = partial ? error.cause : error;
    const kept = partial ? error.state : state;
    logger.error('Step failed', { ms: failed.ms, error: errorMessage(cause) });
    throw new StepFailure(step, { ...kept, timings: [...kept.timings, failed] }, cause);
  }
}

/**
 * Ollama must be up and have every model this run uses before anything is collected. The model
 * of a guard role whose checks are all off is not needed (F30).
 */
async function assertModelsReady(ctx: RunContext): Promise<void> {
  const { model, profile, config } = ctx.deps;
  const health = await readHealth(model);
  if (!health.reachable) {
    const reason = health.error ? `: ${health.error}` : '';
    throw new DigestError(`Ollama is not reachable${reason}. Start Ollama and run again.`);
  }
  const required = modelsInUse(profile, config.guards);
  const available = new Set(health.models.map((entry) => withTag(entry.name)));
  const missing = required.filter((tag) => !available.has(withTag(tag)));
  if (missing.length > 0) {
    throw new DigestError(
      `Ollama is missing models for profile "${profile.name}": ${missing.join(', ')}. ` +
        'Pull them with "ollama pull <model>".',
    );
  }
  ctx.logger.info('Models ready', { profile: profile.name, models: required });
}

async function readHealth(model: ModelProvider): Promise<ModelHealth> {
  try {
    return await model.health();
  } catch (error) {
    return { reachable: false, models: [], error: errorMessage(error) };
  }
}

/** Ollama lists "clef:latest" for a model pulled as "clef". */
function withTag(name: string): string {
  return name.includes(':') ? name : `${name}:latest`;
}

/** Writes a run file now, or holds it for `endRun` when the week's files must stay as they are. */
async function keepArtifact(
  ctx: RunContext,
  state: ChainState,
  name: ArtifactName,
  content: string,
): Promise<ChainState> {
  if (!ctx.holdArtifacts) {
    await ctx.deps.store.saveArtifact(ctx.weekId, name, content);
    return state;
  }
  return { ...state, held: [...state.held, { name, content }] };
}

async function collect(ctx: RunContext, state: ChainState, logger: Logger): Promise<ChainState> {
  const { config, fetchers, clock } = ctx.deps;
  const until = ctx.startedAt;
  const since = new Date(until.getTime() - ctx.sinceDays * DAY_MS);
  const { items, failedSources } = await collectStep(
    { sources: config.sources, since, until, maxItemsPerSource: config.maxItemsPerSource },
    { fetchers, logger, clock },
  );
  const held = await keepArtifact(ctx, state, 'items.json', toJson(items));
  logger.info('Collected items', { items: items.length, failedSources: failedSources.length });
  const next = { ...held, collected: items, failedSources };
  if (items.length > 0) return next;
  const failed = failedSources.length > 0;
  const detail = failed
    ? ` (${failedSources.length} of ${config.sources.length} sources failed)`
    : '';
  return { ...next, settled: { status: 'quiet', note: `no items collected${detail}` } };
}

async function guardInput(ctx: RunContext, state: ChainState, logger: Logger): Promise<ChainState> {
  const { inputGuards, config } = ctx.deps;
  const { kept, dropped } = await guardInputStep(state.collected, {
    guards: inputGuards,
    config: config.guards.input,
    logger,
  });
  logger.info('Input guards done', { kept: kept.length, dropped: dropped.length });
  return { ...state, kept };
}

async function classify(ctx: RunContext, state: ChainState, logger: Logger): Promise<ChainState> {
  const { model, config } = ctx.deps;
  const scored = await classifyStep(state.kept, { model, focusAreas: config.focusAreas, logger });
  const classifications = scored.map((item) => item.classification);
  const held = await keepArtifact(ctx, state, 'scores.json', toJson(classifications));
  return { ...held, scored };
}

async function selectItems(
  ctx: RunContext,
  state: ChainState,
  logger: Logger,
): Promise<ChainState> {
  const { config, store } = ctx.deps;
  const sentUrls = await store.sentUrls(ctx.weekId, config.dedupeWeeks);
  const { selected, dropped } = processStep({
    items: state.scored,
    sentUrls,
    thresholds: config.thresholds,
    topN: config.topN,
  });
  logger.info('Selected items', { selected: selected.length, dropped: dropped.length });
  const cut = dropped.filter((item) => item.reason === 'below-top-n').length;
  const next = { ...state, selected, afterProcess: selected.length + cut };
  if (selected.length >= DIGEST_MIN_ITEMS) return next;
  logger.info('Quiet week: too few items for a digest', { needed: DIGEST_MIN_ITEMS });
  return { ...next, settled: { status: 'quiet' } };
}

async function write(ctx: RunContext, state: ChainState, logger: Logger): Promise<ChainState> {
  const { model, profile, config } = ctx.deps;
  const { checked, writeFailures, retryFailures, rejections } = await writeCheckedStep(
    state.selected,
    {
      model,
      writers: profile.writers,
      focusAreas: config.focusAreas,
      weekId: ctx.weekId,
      logger,
      collected: state.collected,
      disabledGuards: ctx.disabledGuards,
      topN: config.topN,
    },
  );
  const written = checked.map((entry) => entry.draft);
  const failures = [
    ...writeFailures,
    ...retryFailures.map((failure) => ({ ...failure, retry: true })),
  ];
  const file = toJson({ drafts: written, failures, rejections });
  const held = await keepArtifact(ctx, state, 'drafts.json', file);
  const failed = writeFailures.map((failure) => rejected(failure.writer, [WRITE_FAILED]));
  const next = { ...held, checked, drafts: failed };
  if (written.length > 0) return next;
  // Names writers only: a writer's error can quote the model's reply. drafts.json has it.
  const writers = writeFailures.map((failure) => failure.writer).join(', ');
  const error = `Every writer failed: ${writers}; drafts.json has the reasons`;
  throw new PartialFailure(next, new DigestError(error, { step: 'write' }));
}

/**
 * The output guards over the drafts that passed the link and format checks (made in the write
 * step). The guards go through all drafts guard by guard, so one guard model is loaded at a time.
 */
async function checkDrafts(
  ctx: RunContext,
  state: ChainState,
  logger: Logger,
): Promise<ChainState> {
  const { outputGuards, config } = ctx.deps;
  const failing = state.checked.filter((entry) => entry.rejectedBy.length > 0);
  const clean = state.checked.filter((entry) => entry.rejectedBy.length === 0);
  const guarded = await guardOutputStep(
    clean.map((entry) => entry.draft),
    state.selected,
    { guards: outputGuards, config: config.guards.output, logger },
  );
  const passing = new Set(guarded.passed);
  const passed = clean.filter((entry) => passing.has(entry.draft));
  const drafts = inWriterOrder(ctx, [
    ...state.drafts,
    ...failing.map((entry) => rejected(entry.draft.writer, entry.rejectedBy)),
    ...guarded.rejected.map((entry) => rejected(entry.draft.writer, flaggedBy(entry.verdicts))),
    ...passed.map((entry): DraftOutcome => ({
      writer: entry.draft.writer,
      passed: true,
      rejectedBy: [],
    })),
  ]);
  const next = { ...state, drafts, passed };
  return passed.length > 0 ? next : { ...next, settled: blocked(drafts) };
}

function rejected(writer: string, rejectedBy: readonly string[]): DraftOutcome {
  return { writer, passed: false, rejectedBy: [...rejectedBy] };
}

function inWriterOrder(ctx: RunContext, outcomes: readonly DraftOutcome[]): DraftOutcome[] {
  const rank = (writer: string): number => {
    const index = ctx.deps.profile.writers.indexOf(writer);
    return index === -1 ? Number.POSITIVE_INFINITY : index;
  };
  return outcomes.toSorted((a, b) => rank(a.writer) - rank(b.writer));
}

/** Names writers and check ids only: both come from config and code, never from a model. */
function blocked(drafts: readonly DraftOutcome[]): Settled {
  const reasons = drafts.map((draft) => `${draft.writer} (${draft.rejectedBy.join(', ')})`);
  const detail = reasons.length > 0 ? `: ${reasons.join('; ')}` : '';
  return { status: 'blocked', note: `every draft was rejected${detail}` };
}

/** The judge runs only when the profile has one and two or more drafts passed. */
async function pickWinner(ctx: RunContext, state: ChainState, logger: Logger): Promise<ChainState> {
  const { model, profile, config } = ctx.deps;
  const [first, ...others] = state.passed;
  if (!first) throw new DigestError('select ran without a passing draft', { step: 'select' });
  const selection: SelectOutput =
    profile.judge !== null && others.length > 0
      ? await selectStep(
          state.passed.map((entry) => entry.draft),
          state.selected,
          { model, focusAreas: config.focusAreas, writerOrder: profile.writers, logger },
        )
      : { winner: first.draft, scores: [], judged: false };
  const winner = state.passed.find((entry) => entry.draft === selection.winner);
  if (!winner)
    throw new DigestError('The judge picked a draft it was not given', { step: 'select' });
  const held = await keepArtifact(ctx, state, 'digest.md', winner.markdown);
  logger.info('Winner chosen', { writer: winner.draft.writer, judged: selection.judged });
  return { ...held, winner, drafts: withScores(state.drafts, selection.scores) };
}

function withScores(
  drafts: readonly DraftOutcome[],
  scores: readonly JudgeScore[],
): DraftOutcome[] {
  return drafts.map((draft) => {
    const score = scores.find((entry) => entry.writer === draft.writer);
    return score ? { ...draft, score } : draft;
  });
}

async function deliver(ctx: RunContext, state: ChainState, logger: Logger): Promise<ChainState> {
  const { winner } = state;
  if (!winner) throw new DigestError('Nothing to deliver: no winning draft', { step: 'deliver' });
  const { headline, items } = winner.draft.digest;
  const message = digestMessage(ctx.weekId, headline, winner.markdown);
  const { deliveredTo, error } = await shipDigest(ctx.deps.deliveries, message, state.deliveredTo);
  // Any channel that took the digest counts its URLs as sent, for cross-week dedupe.
  const sentUrls = deliveredTo.length > 0 ? items.map((item) => item.url) : [];
  const next = { ...state, deliveredTo, sentUrls };
  if (error) throw new PartialFailure(next, error);
  logger.info('Digest delivered', { channels: deliveredTo });
  return next;
}

/** A resume sends the saved digest only; its record keeps the previous run's results. */
async function resumed(ctx: RunContext, part: PartDelivery): Promise<RunResult> {
  const { record, markdown } = await resumeDelivery(ctx, part);
  return { record, exitCode: exitCodeFor(record.status), markdown };
}

// ---------------------------------------------------------------------------------------------
// After the chain: the record and the result. runEnding saves and reports the record.

/** `previous`: the week's record before this run, if any. */
async function finish(
  ctx: RunContext,
  outcome: ChainOutcome,
  previous: RunRecord | undefined,
): Promise<RunResult> {
  const { failure, state } = outcome;
  const record = buildRecord(ctx, outcome, statusOf(ctx, outcome), ctx.deps.clock.now());
  const written = await endRun(
    ctx,
    { record, failure, note: noteFor(ctx, outcome), artifacts: state.held },
    previous,
  );
  // `digest run` prints digest.md's path whenever markdown is set: only for a file this run wrote.
  const digestWritten = !ctx.holdArtifacts || written.has('digest.md');
  const markdown = digestWritten ? state.winner?.markdown : undefined;
  return { record, exitCode: exitCodeFor(record.status), markdown };
}

function statusOf(ctx: RunContext, outcome: ChainOutcome): RunStatus {
  if (outcome.failure) return 'failed';
  if (outcome.state.settled) return outcome.state.settled.status;
  return ctx.dryRun ? 'dry-run' : 'sent';
}

function buildRecord(
  ctx: RunContext,
  outcome: ChainOutcome,
  status: RunStatus,
  finishedAt: Date,
): RunRecord {
  const { state, failure } = outcome;
  const { profile } = ctx.deps;
  return {
    runId: ctx.weekId,
    status,
    dryRun: ctx.dryRun,
    startedAt: ctx.startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    profile: profile.name,
    modelsByRole: modelsByRole(profile),
    timings: [...state.timings],
    counts: {
      collected: state.collected.length,
      afterGuardInput: state.kept.length,
      classified: state.scored.length,
      ...(state.afterProcess !== undefined && { afterProcess: state.afterProcess }),
      selected: state.selected.length,
      digestItems: state.winner?.draft.digest.items.length ?? 0,
    },
    failedSources: [...state.failedSources],
    disabledGuards: [...ctx.disabledGuards],
    drafts: [...state.drafts],
    winner: state.winner?.draft.writer ?? null,
    sentUrls: [...state.sentUrls],
    ...(state.deliveredTo.length > 0 && { deliveredTo: [...state.deliveredTo] }),
    ...(failure && { error: recordError(failure) }),
  };
}

function noteFor(ctx: RunContext, outcome: ChainOutcome): FailureNote | undefined {
  const { failure, state } = outcome;
  if (failure) return failureNote(ctx.weekId, failure);
  const note = state.settled?.note;
  return note === undefined
    ? undefined
    : { weekId: ctx.weekId, step: state.settled?.step, message: note };
}
