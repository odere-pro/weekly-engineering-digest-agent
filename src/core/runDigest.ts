import type { Config } from '../config/schema.js';
import { modelsByRole, requiredModels, type ModelProfile } from '../config/profiles.js';
import type { Delivery, FailureNote } from '../ports/Delivery.js';
import type { InputGuard, OutputGuard } from '../ports/Guard.js';
import type { ModelHealth, ModelProvider } from '../ports/ModelProvider.js';
import type { RunLock, RunStore } from '../ports/RunStore.js';
import type { SourceFetcher } from '../ports/SourceFetcher.js';
import type { Clock } from '../shared/clock.js';
import { DigestError, errorMessage } from '../shared/errors.js';
import { isoWeekId } from '../shared/isoWeek.js';
import { noopLogger, type Logger, type Tracer } from '../shared/telemetry.js';
import { truncate } from '../shared/text.js';
import { formatCheck } from './checks/formatCheck.js';
import { linkCheck } from './checks/linkCheck.js';
import { DIGEST_MIN_ITEMS } from './prompts/write.js';
import { renderDigest } from './render.js';
import {
  WEEK_ID_PATTERN,
  exitCodeFor,
  type DigestItem,
  type Draft,
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
import { flaggedBy, guardInputStep, planGuards } from './steps/guardInput.js';
import { guardOutputStep } from './steps/guardOutput.js';
import { processStep } from './steps/process.js';
import { selectStep } from './steps/select.js';
import { writeStep } from './steps/write.js';
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
}

export interface RunResult {
  record: RunRecord;
  exitCode: ExitCode;
  /** Markdown of the winning digest, when one was produced. */
  markdown?: string;
}

const WORKFLOW_ID = 'digest';
const DAY_MS = 86_400_000;
const SUBJECT_MAX_CHARS = 120;
/**
 * Feed titles carry em dashes the format check rejects. A run of them, with the spaces and
 * commas around it, becomes one comma; at either end of a field it is dropped.
 */
const EM_DASH_RUN = /[\s,]*\u2014[\s,\u2014]*/g;
const EM_DASH_REPLACEMENT = ', ';
const WRITE_FAILED = 'write';

/** One run's fixed inputs, resolved before anything runs. */
interface RunContext {
  readonly deps: DigestDeps;
  readonly weekId: string;
  readonly dryRun: boolean;
  readonly sinceDays: number;
  readonly startedAt: Date;
  /** Bound to the run id. */
  readonly logger: Logger;
  /** Input then output checks that are off this run, in config order. */
  readonly disabledGuards: readonly GuardCheckId[];
}

/** A draft that passed the code checks, with the exact Markdown that was checked. */
interface CheckedDraft {
  readonly draft: Draft;
  readonly markdown: string;
}

/** Ends the run early with this status; the remaining steps are skipped. */
interface Settled {
  readonly status: 'quiet' | 'blocked';
  readonly step: StepName;
  /** Sent as a failure note; none for an ordinary quiet week. */
  readonly note?: string;
}

/** What the chain has produced so far. Every step returns a new state. */
interface ChainState {
  readonly collected: readonly Item[];
  readonly failedSources: RunRecord['failedSources'];
  readonly kept: readonly Item[];
  readonly scored: readonly ScoredItem[];
  readonly selected: readonly ScoredItem[];
  readonly written: readonly Draft[];
  readonly drafts: readonly DraftOutcome[];
  readonly passed: readonly CheckedDraft[];
  readonly winner?: CheckedDraft;
  readonly sentUrls: readonly string[];
  readonly timings: RunRecord['timings'];
  readonly settled?: Settled;
}

interface DeliveryFailure {
  readonly id: Delivery['id'];
  readonly error: string;
}

interface ChainOutcome {
  readonly state: ChainState;
  readonly failure?: { readonly error: unknown; readonly step?: StepName };
}

const EMPTY_STATE: ChainState = {
  collected: [],
  failedSources: [],
  kept: [],
  scored: [],
  selected: [],
  written: [],
  drafts: [],
  passed: [],
  sentUrls: [],
  timings: [],
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

/** The whole chain: collect, guard-input, classify, process, write, guard-output, select, deliver (W2-01). */
export async function runDigest(deps: DigestDeps, options: RunOptions = {}): Promise<RunResult> {
  const ctx = runContext(deps, options);
  return deps.tracer.span('runDigest', { runId: ctx.weekId, dryRun: ctx.dryRun }, async () => {
    if (!options.force && (await deps.store.hasSentDigest(ctx.weekId))) return skipped(ctx);
    const lock = await deps.store.acquireLock(ctx.weekId);
    try {
      // Checked again under the lock: a run that held it may have just sent this week.
      const sentBefore = await deps.store.hasSentDigest(ctx.weekId);
      if (sentBefore && !options.force) return skipped(ctx);
      return await finish(ctx, await runChain(ctx), sentBefore);
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
    logger: deps.logger.child({ runId: weekId }),
    disabledGuards: plannedDisabledGuards(deps),
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

/** Never rejects: a failure comes back with the state of the steps that finished before it. */
async function runChain(ctx: RunContext): Promise<ChainOutcome> {
  try {
    await assertModelsReady(ctx);
    return { state: await runWorkflow(WORKFLOW_ID, chainSteps(ctx), EMPTY_STATE) };
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

/** Skips a settled run; otherwise times, traces and logs the step with the run id and step. */
function stage(ctx: RunContext, step: StepName, fn: StageFn): WorkflowStep<ChainState> {
  return {
    id: step,
    run: (state) => (state.settled ? Promise.resolve(state) : timed(ctx, step, state, fn)),
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
    return { ...next, timings: [...next.timings, done] };
  } catch (error) {
    const failed = timing();
    logger.error('Step failed', { ms: failed.ms, error: errorMessage(error) });
    throw new StepFailure(step, { ...state, timings: [...state.timings, failed] }, error);
  }
}

/** Ollama must be up and have every model of the profile before anything is collected. */
async function assertModelsReady(ctx: RunContext): Promise<void> {
  const { model, profile } = ctx.deps;
  const health = await readHealth(model);
  if (!health.reachable) {
    const reason = health.error ? `: ${health.error}` : '';
    throw new DigestError(`Ollama is not reachable${reason}. Start Ollama and run again.`);
  }
  const available = new Set(health.models.map((entry) => withTag(entry.name)));
  const missing = requiredModels(profile).filter((tag) => !available.has(withTag(tag)));
  if (missing.length > 0) {
    throw new DigestError(
      `Ollama is missing models for profile "${profile.name}": ${missing.join(', ')}. ` +
        'Pull them with "ollama pull <model>".',
    );
  }
  ctx.logger.info('Models ready', { profile: profile.name, models: requiredModels(profile) });
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

async function collect(ctx: RunContext, state: ChainState, logger: Logger): Promise<ChainState> {
  const { config, fetchers, clock, store } = ctx.deps;
  const until = ctx.startedAt;
  const since = new Date(until.getTime() - ctx.sinceDays * DAY_MS);
  const { items, failedSources } = await collectStep(
    { sources: config.sources, since, until, maxItemsPerSource: config.maxItemsPerSource },
    { fetchers, logger, clock },
  );
  await store.saveArtifact(ctx.weekId, 'items.json', toJson(items));
  logger.info('Collected items', { items: items.length, failedSources: failedSources.length });
  const next = { ...state, collected: items, failedSources };
  if (items.length > 0) return next;
  const failed = failedSources.length > 0;
  const detail = failed
    ? ` (${failedSources.length} of ${config.sources.length} sources failed)`
    : '';
  return {
    ...next,
    settled: { status: 'quiet', step: 'collect', note: `no items collected${detail}` },
  };
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
  const { model, config, store } = ctx.deps;
  const scored = await classifyStep(state.kept, { model, focusAreas: config.focusAreas, logger });
  const classifications = scored.map((item) => item.classification);
  await store.saveArtifact(ctx.weekId, 'scores.json', toJson(classifications));
  return { ...state, scored };
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
  const next = { ...state, selected };
  if (selected.length >= DIGEST_MIN_ITEMS) return next;
  logger.info('Quiet week: too few items for a digest', { needed: DIGEST_MIN_ITEMS });
  return { ...next, settled: { status: 'quiet', step: 'process' } };
}

async function write(ctx: RunContext, state: ChainState, logger: Logger): Promise<ChainState> {
  const { model, profile, config, store } = ctx.deps;
  const { drafts, failures } = await writeStep(state.selected, {
    model,
    writers: profile.writers,
    focusAreas: config.focusAreas,
    weekId: ctx.weekId,
    logger,
  });
  const written = drafts.map((draft) => prepareDraft(draft, config.topN));
  await store.saveArtifact(ctx.weekId, 'drafts.json', toJson({ drafts: written, failures }));
  const failed = failures.map((failure) => rejected(failure.writer, [WRITE_FAILED]));
  return { ...state, written, drafts: failed };
}

/** Deterministic fixes the writers keep needing: at most topN items (defense in depth), no em dashes. */
function prepareDraft(draft: Draft, topN: number): Draft {
  const { digest } = draft;
  const items = digest.items.slice(0, topN).map((item): DigestItem => ({
    ...item,
    title: withoutEmDashes(item.title),
    area: withoutEmDashes(item.area),
    summary: withoutEmDashes(item.summary),
    whyItMatters: withoutEmDashes(item.whyItMatters),
  }));
  const headline = withoutEmDashes(digest.headline);
  return { ...draft, digest: { ...digest, headline, intro: withoutEmDashes(digest.intro), items } };
}

function withoutEmDashes(text: string): string {
  return text.replace(EM_DASH_RUN, (run: string, offset: number) =>
    offset === 0 || offset + run.length === text.length ? '' : EM_DASH_REPLACEMENT,
  );
}

/**
 * Link and format checks per draft, then the output guards over the drafts that passed them.
 * The guards go through all drafts guard by guard, so one guard model is loaded at a time.
 */
async function checkDrafts(
  ctx: RunContext,
  state: ChainState,
  logger: Logger,
): Promise<ChainState> {
  const { outputGuards, config } = ctx.deps;
  const checked = state.written.map((draft) => codeCheck(draft, state.collected, ctx));
  const failing = checked.filter((entry) => entry.rejectedBy.length > 0);
  for (const { draft, rejectedBy } of failing) {
    logger.warn('Draft failed the checks', { writer: draft.writer, rejectedBy });
  }
  const clean = checked.filter((entry) => entry.rejectedBy.length === 0);
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

function codeCheck(
  draft: Draft,
  collected: readonly Item[],
  ctx: RunContext,
): CheckedDraft & { rejectedBy: string[] } {
  const markdown = renderDigest(draft.digest, { disabledGuards: ctx.disabledGuards });
  const rejectedBy = [
    ...(linkCheck(draft.digest, markdown, collected).ok ? [] : ['linkCheck']),
    ...(formatCheck(draft.digest, markdown).ok ? [] : ['formatCheck']),
  ];
  return { draft, markdown, rejectedBy };
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
  return { status: 'blocked', step: 'guardOutput', note: `every draft was rejected${detail}` };
}

/** The judge runs only when the profile has one and two or more drafts passed. */
async function pickWinner(ctx: RunContext, state: ChainState, logger: Logger): Promise<ChainState> {
  const { model, profile, config, store } = ctx.deps;
  const [first, ...others] = state.passed;
  if (!first) throw new DigestError('select ran without a passing draft', { step: 'select' });
  const judged =
    profile.judge !== null && others.length > 0
      ? await selectStep(
          state.passed.map((entry) => entry.draft),
          state.selected,
          { model, focusAreas: config.focusAreas, writerOrder: profile.writers, logger },
        )
      : { winner: first.draft, scores: [] };
  const winner = state.passed.find((entry) => entry.draft === judged.winner);
  if (!winner)
    throw new DigestError('The judge picked a draft it was not given', { step: 'select' });
  await store.saveArtifact(ctx.weekId, 'digest.md', winner.markdown);
  logger.info('Winner chosen', { writer: winner.draft.writer, judged: judged.scores.length > 0 });
  return { ...state, winner, drafts: withScores(state.drafts, judged.scores) };
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

/** Tries every channel, then fails the step if any of them failed. */
async function deliver(ctx: RunContext, state: ChainState, logger: Logger): Promise<ChainState> {
  const { winner } = state;
  if (!winner) throw new DigestError('Nothing to deliver: no winning draft', { step: 'deliver' });
  const message = {
    weekId: ctx.weekId,
    subject: subjectFor(ctx.weekId, winner.draft.digest.headline),
    markdown: winner.markdown,
  };
  const failures = await forEachDelivery(ctx.deps.deliveries, (delivery) =>
    delivery.sendDigest(message),
  );
  if (failures.length > 0) throw deliveryError(ctx.deps.deliveries, failures);
  logger.info('Digest delivered', { channels: ctx.deps.deliveries.map((delivery) => delivery.id) });
  return { ...state, sentUrls: winner.draft.digest.items.map((item) => item.url) };
}

/** Names the channels that did get the digest, so a retry's duplicates are expected. */
function deliveryError(
  deliveries: readonly Delivery[],
  failures: readonly DeliveryFailure[],
): DigestError {
  const failed = new Set(failures.map((failure) => failure.id));
  const delivered = deliveries.map((d) => d.id).filter((id) => !failed.has(id));
  const detail = failures.map((failure) => `${failure.id} (${failure.error})`).join(', ');
  const done = delivered.length > 0 ? `; delivered on ${delivered.join(', ')}` : '';
  return new DigestError(`Delivery failed on ${detail}${done}`, { step: 'deliver' });
}

function subjectFor(weekId: string, headline: string): string {
  const oneLine = headline.replace(/\s+/g, ' ').trim();
  return truncate(`Engineering digest ${weekId}: ${oneLine}`, SUBJECT_MAX_CHARS);
}

/** Sends to each channel in turn; returns the ones that failed instead of throwing. */
async function forEachDelivery(
  deliveries: readonly Delivery[],
  send: (delivery: Delivery) => Promise<void>,
): Promise<DeliveryFailure[]> {
  const failures: DeliveryFailure[] = [];
  for (const delivery of deliveries) {
    try {
      await send(delivery);
    } catch (error) {
      failures.push({ id: delivery.id, error: errorMessage(error) });
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------------------------
// After the chain: run record, error file, failure note, pruning

/** `sentBefore`: the week already had a sent digest and this is a forced run. */
async function finish(
  ctx: RunContext,
  outcome: ChainOutcome,
  sentBefore: boolean,
): Promise<RunResult> {
  const status = statusOf(ctx, outcome);
  const finishedAt = ctx.deps.clock.now();
  const record = buildRecord(ctx, outcome, status, finishedAt);
  await saveRecord(ctx, record, sentBefore);
  if (outcome.failure) await saveErrorFile(ctx, outcome.failure, finishedAt);
  await sendFailureNote(ctx, noteFor(ctx, outcome));
  await pruneOldRuns(ctx);
  ctx.logger.info('Run finished', { status, winner: record.winner, counts: record.counts });
  return { record, exitCode: exitCodeFor(status), markdown: outcome.state.winner?.markdown };
}

/**
 * A forced run that does not send never replaces a sent record: the week would look unsent,
 * and the scheduler would send it again. A record that cannot be saved is alerted, then thrown.
 */
async function saveRecord(ctx: RunContext, record: RunRecord, sentBefore: boolean): Promise<void> {
  if (sentBefore && record.status !== 'sent') {
    ctx.logger.warn('Kept the sent run record; this forced run did not send', {
      status: record.status,
    });
    return;
  }
  try {
    await ctx.deps.store.saveRunRecord(record);
  } catch (error) {
    const outcome = record.error ? `failed: ${record.error.message}` : `ended ${record.status}`;
    const message = `Could not save the run record (${errorMessage(error)}); the run ${outcome}`;
    ctx.logger.error('Could not save the run record', { error: errorMessage(error) });
    await sendFailureNote(ctx, { weekId: ctx.weekId, message });
    throw new DigestError(message, { cause: error });
  }
}

/** Best effort: run.json already holds the error; this file only adds the stack. */
async function saveErrorFile(
  ctx: RunContext,
  failure: NonNullable<ChainOutcome['failure']>,
  at: Date,
): Promise<void> {
  try {
    await ctx.deps.store.saveArtifact(ctx.weekId, 'error.json', errorFile(ctx, failure, at));
  } catch (error) {
    ctx.logger.error('Could not write error.json', { error: errorMessage(error) });
  }
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
      selected: state.selected.length,
      digestItems: state.winner?.draft.digest.items.length ?? 0,
    },
    failedSources: [...state.failedSources],
    disabledGuards: [...ctx.disabledGuards],
    drafts: [...state.drafts],
    winner: state.winner?.draft.writer ?? null,
    sentUrls: [...state.sentUrls],
    ...(failure && { error: { message: errorMessage(failure.error), step: failure.step } }),
  };
}

function errorFile(ctx: RunContext, failure: NonNullable<ChainOutcome['failure']>, at: Date) {
  const { error, step } = failure;
  return toJson({
    runId: ctx.weekId,
    step,
    name: error instanceof Error ? error.name : 'Error',
    message: errorMessage(error),
    at: at.toISOString(),
    stack: error instanceof Error ? error.stack : undefined,
  });
}

function noteFor(ctx: RunContext, outcome: ChainOutcome): FailureNote | undefined {
  const { failure, state } = outcome;
  if (failure) {
    return { weekId: ctx.weekId, step: failure.step, message: errorMessage(failure.error) };
  }
  const note = state.settled?.note;
  return note === undefined
    ? undefined
    : { weekId: ctx.weekId, step: state.settled?.step, message: note };
}

/** Best effort: a channel that cannot take the note is logged, the run outcome stands. */
async function sendFailureNote(ctx: RunContext, note: FailureNote | undefined): Promise<void> {
  if (!note || ctx.dryRun) return;
  const failures = await forEachDelivery(ctx.deps.deliveries, (delivery) =>
    delivery.sendFailure(note),
  );
  for (const failure of failures) {
    ctx.logger.error('Could not send the failure note', {
      delivery: failure.id,
      error: failure.error,
    });
  }
}

async function pruneOldRuns(ctx: RunContext): Promise<void> {
  try {
    const pruned = await ctx.deps.store.prune(ctx.weekId, ctx.deps.config.keepWeeks);
    if (pruned.length > 0) ctx.logger.info('Pruned old runs', { pruned });
  } catch (error) {
    ctx.logger.error('Could not prune old runs', { error: errorMessage(error) });
  }
}

function toJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
