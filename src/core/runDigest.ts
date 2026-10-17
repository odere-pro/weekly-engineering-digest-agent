import type { Config } from '../config/schema.js';
import { modelsByRole, requiredModels, type ModelProfile } from '../config/profiles.js';
import type { Delivery, DigestMessage, FailureNote } from '../ports/Delivery.js';
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
  endRun,
  failureNote,
  forEachDelivery,
  recordError,
  toJson,
  type DeliveryFailure,
  type Failure,
} from './runEnding.js';
import {
  WEEK_ID_PATTERN,
  exitCodeFor,
  type DeliveryId,
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
/** render.ts writes the headline as the digest's first `# ` line... */
const HEADLINE_LINE = /^# (.+)$/m;
/** ...and each item's link as a `[Source](url)` line of its own. */
const SOURCE_LINE = /^\[Source\]\((.+)\)$/gm;

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
  readonly selected: readonly ScoredItem[];
  readonly written: readonly Draft[];
  readonly drafts: readonly DraftOutcome[];
  readonly passed: readonly CheckedDraft[];
  readonly winner?: CheckedDraft;
  readonly sentUrls: readonly string[];
  /** Channels that took the digest, in the order they took it. */
  readonly deliveredTo: readonly DeliveryId[];
  readonly timings: RunRecord['timings'];
  readonly settled?: Settled;
}

interface ChainOutcome {
  readonly state: ChainState;
  readonly failure?: Failure;
}

/** A failed run that reached some channels, and the digest.md saved for the week, if any. */
interface PartDelivered {
  readonly previous: RunRecord;
  readonly deliveredTo: readonly DeliveryId[];
  readonly markdown: string | undefined;
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
  deliveredTo: [],
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
      const partDelivered = options.force || ctx.dryRun ? undefined : await saved(ctx, previous);
      if (partDelivered) return await resume(ctx, partDelivered);
      return await finish(ctx, await runChain(ctx), previous);
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
// Resuming a partly delivered week

/** The previous run, when it failed after reaching some channels; with its digest.md if saved. */
async function saved(
  ctx: RunContext,
  previous: RunRecord | undefined,
): Promise<PartDelivered | undefined> {
  const deliveredTo = previous?.deliveredTo ?? [];
  if (previous?.status !== 'failed' || deliveredTo.length === 0) return undefined;
  const markdown = await ctx.deps.store.readArtifact(ctx.weekId, 'digest.md');
  return { previous, deliveredTo, markdown };
}

/**
 * Sends the saved digest to the channels the failed run missed: no health check, no model call.
 * The record keeps the previous run's results, with the new outcome, channels and deliver timing.
 */
async function resume(ctx: RunContext, part: PartDelivered): Promise<RunResult> {
  const { previous, deliveredTo, markdown } = part;
  const missing = ctx.deps.deliveries.filter((delivery) => !deliveredTo.includes(delivery.id));
  ctx.logger.info('Resuming the delivery of the saved digest', {
    deliveredTo,
    channels: missing.map((delivery) => delivery.id),
  });
  const start: ChainState = { ...EMPTY_STATE, deliveredTo };
  const { state, failure } = await settle(ctx, () =>
    timed(ctx, 'deliver', start, async (_ctx, from, logger) => {
      const digest = sameDigest(part);
      const message = digestMessage(ctx.weekId, HEADLINE_LINE.exec(digest)?.[1] ?? '', digest);
      return deliverDigest({ channels: missing, message, urls: previous.sentUrls }, from, logger);
    }),
  );
  const { error: _previousError, ...kept } = previous;
  const record: RunRecord = {
    ...kept,
    status: failure ? 'failed' : 'sent',
    startedAt: ctx.startedAt.toISOString(),
    finishedAt: ctx.deps.clock.now().toISOString(),
    timings: [...previous.timings, ...state.timings],
    deliveredTo: [...state.deliveredTo],
    ...(failure && { error: recordError(failure) }),
  };
  await endRun(
    ctx,
    { record, failure, note: failure && failureNote(ctx.weekId, failure) },
    previous,
  );
  return { record, exitCode: exitCodeFor(record.status), markdown };
}

/**
 * The saved digest, when its links are exactly the URLs the other channels got. A dry or forced
 * run since then may have replaced it; sending that would split the week, so a person decides.
 */
function sameDigest({ previous, deliveredTo, markdown }: PartDelivered): string {
  const redo = 'run with --force to send a new digest to every channel';
  if (markdown === undefined) {
    throw new DigestError(`The partly delivered digest.md is gone; ${redo}`, { step: 'deliver' });
  }
  const links = new Set(Array.from(markdown.matchAll(SOURCE_LINE), (match) => match[1]));
  const sent = new Set(previous.sentUrls);
  if (links.size !== sent.size || [...sent].some((url) => !links.has(url))) {
    const channels = deliveredTo.join(', ');
    const message = `digest.md no longer matches the digest ${channels} got; ${redo}`;
    throw new DigestError(message, { step: 'deliver' });
  }
  return markdown;
}

// ---------------------------------------------------------------------------------------------
// The chain

function runChain(ctx: RunContext): Promise<ChainOutcome> {
  return settle(ctx, async () => {
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
  return { ...next, settled: { status: 'quiet' } };
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
  const next = { ...state, written, drafts: failed };
  if (written.length > 0) return next;
  // Names writers only: a writer's error can quote the model's reply. drafts.json has it.
  const writers = failures.map((failure) => failure.writer).join(', ');
  const error = `Every writer failed: ${writers}; drafts.json has the reasons`;
  throw new PartialFailure(next, new DigestError(error, { step: 'write' }));
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
  return { status: 'blocked', note: `every draft was rejected${detail}` };
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

async function deliver(ctx: RunContext, state: ChainState, logger: Logger): Promise<ChainState> {
  const { winner } = state;
  if (!winner) throw new DigestError('Nothing to deliver: no winning draft', { step: 'deliver' });
  const { headline, items } = winner.draft.digest;
  const message = digestMessage(ctx.weekId, headline, winner.markdown);
  const urls = items.map((item) => item.url);
  return deliverDigest({ channels: ctx.deps.deliveries, message, urls }, state, logger);
}

interface Shipment {
  readonly channels: readonly Delivery[];
  readonly message: DigestMessage;
  /** The digest's URLs; they count as sent once any channel has them, for cross-week dedupe. */
  readonly urls: readonly string[];
}

/** Tries every channel and records the ones that took it; any failed channel fails the step. */
async function deliverDigest(
  { channels, message, urls }: Shipment,
  state: ChainState,
  logger: Logger,
): Promise<ChainState> {
  const failures = await forEachDelivery(channels, (delivery) => delivery.sendDigest(message));
  const failed = new Set(failures.map((failure) => failure.id));
  const reached = channels.map((delivery) => delivery.id).filter((id) => !failed.has(id));
  const deliveredTo = [...state.deliveredTo, ...reached];
  const next = { ...state, deliveredTo, sentUrls: deliveredTo.length > 0 ? [...urls] : [] };
  if (failures.length > 0) throw new PartialFailure(next, deliveryError(deliveredTo, failures));
  logger.info('Digest delivered', { channels: reached });
  return next;
}

/** Names the channels that did get the digest; a rerun sends only to the others. */
function deliveryError(
  deliveredTo: readonly DeliveryId[],
  failures: readonly DeliveryFailure[],
): DigestError {
  const detail = failures.map((failure) => `${failure.id} (${failure.error})`).join(', ');
  const done = deliveredTo.length > 0 ? `; delivered on ${deliveredTo.join(', ')}` : '';
  return new DigestError(`Delivery failed on ${detail}${done}`, { step: 'deliver' });
}

function digestMessage(weekId: string, headline: string, markdown: string): DigestMessage {
  const oneLine = headline.replace(/\s+/g, ' ').trim();
  const subject = oneLine
    ? `Engineering digest ${weekId}: ${oneLine}`
    : `Engineering digest ${weekId}`;
  return { weekId, subject: truncate(subject, SUBJECT_MAX_CHARS), markdown };
}

// ---------------------------------------------------------------------------------------------
// After the chain: the record and the result. runEnding saves and reports the record.

/** `previous`: the week's record before this run, if any. */
async function finish(
  ctx: RunContext,
  outcome: ChainOutcome,
  previous: RunRecord | undefined,
): Promise<RunResult> {
  const record = buildRecord(ctx, outcome, statusOf(ctx, outcome), ctx.deps.clock.now());
  await endRun(ctx, { record, failure: outcome.failure, note: noteFor(ctx, outcome) }, previous);
  return { record, exitCode: exitCodeFor(record.status), markdown: outcome.state.winner?.markdown };
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
