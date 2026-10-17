// Raw model outputs for threshold tuning (W3-03): the schema of evals/thresholds/raw/*.json and
// the capture that fills it, calling each model once per subject. evals/tuneThresholds.ts runs it.
import { z } from 'zod';
import { ProfileNameSchema, ThresholdsSchema } from '../../src/config/schema.js';
import { WeekIdSchema, type Draft, type Item } from '../../src/core/schemas.js';
import { classifyStep } from '../../src/core/steps/classify.js';
import type { InputGuard, OutputGuard } from '../../src/ports/Guard.js';
import type { ModelProvider } from '../../src/ports/ModelProvider.js';
import type { Clock } from '../../src/shared/clock.js';
import { DigestError, errorMessage } from '../../src/shared/errors.js';
import type { Logger } from '../../src/shared/telemetry.js';
import type { EvalCases } from '../runEval.js';
import type { ClassifierCase, WeekLabels } from '../schema.js';

// --- Raw outputs ----------------------------------------------------------------------------

const Probability = z.number().min(0).max(1);
const Relevance = z.number().min(0).max(3);
const FailedSchema = z.object({ error: z.string().min(1) });
export type Failed = z.infer<typeof FailedSchema>;

const ClassifiedSchema = z.object({
  relevance: Relevance,
  area: z.string().min(1),
  areaConfidence: Probability,
  hype: Probability,
  minorRelease: Probability,
});
export type Classified = z.infer<typeof ClassifiedSchema>;
const ClassifyResultSchema = z.union([ClassifiedSchema, FailedSchema]);
const ProbabilityResultSchema = z.union([z.object({ probability: Probability }), FailedSchema]);

const ClassifierRecordSchema = z.object({
  itemId: z.string().min(1),
  expected: z.object({ area: z.string().min(1), relevance: Relevance }),
  result: ClassifyResultSchema,
});
export type ClassifierRecord = z.infer<typeof ClassifierRecordSchema>;

const WeekItemRecordSchema = z.object({
  itemId: z.string().min(1),
  weekId: WeekIdSchema,
  label: z.enum(['mustInclude', 'mustExclude']).nullable(),
  result: ClassifyResultSchema,
});
export type WeekItemRecord = z.infer<typeof WeekItemRecordSchema>;

const InputGuardRecordSchema = z.object({
  itemId: z.string().min(1),
  title: z.string(),
  /** clean: an item of a recorded week. attack: an attack case. */
  kind: z.enum(['clean', 'attack']),
  /** The week id or the attack case id. */
  from: z.string().min(1),
  /** The highest P(yes) over the guard's questions; it flags above guardFlag. */
  clefPolicy: ProbabilityResultSchema,
  graniteRisk: z.union([
    z.object({ flagged: z.boolean(), reason: z.string().optional() }),
    FailedSchema,
  ]),
});
export type InputGuardRecord = z.infer<typeof InputGuardRecordSchema>;

const OutputGuardRecordSchema = z.object({
  caseId: z.string().min(1),
  /** planted: the grounding case's draft. control: that draft without the planted item. */
  draft: z.enum(['planted', 'control']),
  clefRubric: ProbabilityResultSchema,
});
export type OutputGuardRecord = z.infer<typeof OutputGuardRecordSchema>;

export const RawCaptureSchema = z.object({
  profile: ProfileNameSchema,
  capturedAt: z.iso.datetime({ offset: true }),
  ollamaVersion: z.string().nullable(),
  models: z.object({ classify: z.string(), guardPolicy: z.string(), guardRisk: z.string() }),
  focusAreas: z.array(z.string()),
  /** The thresholds in config when the outputs were captured; the sweep starts from them. */
  baseline: ThresholdsSchema,
  classifier: z.array(ClassifierRecordSchema),
  weekItems: z.array(WeekItemRecordSchema),
  inputGuards: z.array(InputGuardRecordSchema),
  outputGuards: z.array(OutputGuardRecordSchema),
  timingsMs: z.record(z.string(), z.number().min(0)),
});
export type RawCapture = z.infer<typeof RawCaptureSchema>;

/** A call that threw: its message instead of an answer. */
export function isFailed(result: object): result is Failed {
  return 'error' in result;
}

/** Every failed call in a capture, by phase. */
export function failedCalls(raw: Omit<CaptureData, 'timingsMs'>): Record<string, number> {
  const count = <T>(records: readonly T[], result: (record: T) => object): number =>
    records.filter((record) => 'error' in result(record)).length;
  return {
    classifier: count(raw.classifier, (r) => r.result),
    weekItems: count(raw.weekItems, (r) => r.result),
    clefPolicy: count(raw.inputGuards, (r) => r.clefPolicy),
    graniteRisk: count(raw.inputGuards, (r) => r.graniteRisk),
    clefRubric: count(raw.outputGuards, (r) => r.clefRubric),
  };
}

// --- Capture --------------------------------------------------------------------------------

export interface CaptureDeps {
  model: ModelProvider;
  focusAreas: readonly string[];
  clefPolicy: InputGuard;
  graniteRisk: InputGuard;
  clefRubric: OutputGuard;
  logger: Logger;
  clock: Clock;
  /** One line per milestone or failed call, so a long run can be followed. */
  progress: (line: string) => void;
}

export type EvalSet = Pick<EvalCases, 'classifier' | 'weeks' | 'attacks' | 'grounding'>;
export type CaptureData = Pick<
  RawCapture,
  'classifier' | 'weekItems' | 'inputGuards' | 'outputGuards' | 'timingsMs'
>;

const PROGRESS_EVERY = 10;

interface GuardSubject {
  item: Item;
  kind: InputGuardRecord['kind'];
  from: string;
}

interface DraftSubject {
  caseId: string;
  draft: OutputGuardRecord['draft'];
  value: Draft;
  sources: readonly Item[];
}

/** A failed call becomes a record of its message, so one bad item does not lose a long run. */
async function attempt<T>(
  deps: CaptureDeps,
  what: string,
  call: () => Promise<T>,
): Promise<T | Failed> {
  try {
    return await call();
  } catch (error) {
    const message = errorMessage(error) || 'unknown error';
    deps.progress(`${what} failed: ${message}`);
    return { error: message };
  }
}

/** Runs `call` on each value in turn (one model call at a time), logging every 10. */
async function inTurn<T, R>(
  deps: CaptureDeps,
  label: string,
  values: readonly T[],
  call: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (const [index, value] of values.entries()) {
    results.push(await call(value));
    const done = index + 1;
    if (done % PROGRESS_EVERY === 0 || done === values.length)
      deps.progress(`${label}: ${done}/${values.length}`);
  }
  return results;
}

async function timed<T>(
  deps: CaptureDeps,
  run: () => Promise<T>,
): Promise<{ value: T; ms: number }> {
  const start = deps.clock.now().getTime();
  const value = await run();
  // Wall-clock time: a clock step during a long run must not give a negative duration.
  return { value, ms: Math.max(0, deps.clock.now().getTime() - start) };
}

async function classifyItem(item: Item, deps: CaptureDeps): Promise<Classified> {
  const [scored] = await classifyStep([item], {
    model: deps.model,
    focusAreas: deps.focusAreas,
    logger: deps.logger,
  });
  if (!scored) throw new DigestError(`classify returned nothing for item ${item.id}`);
  const { relevance, area, areaConfidence, hype, minorRelease } = scored.classification;
  return { relevance, area, areaConfidence, hype, minorRelease };
}

async function policyProbability(item: Item, deps: CaptureDeps): Promise<{ probability: number }> {
  const verdict = await deps.clefPolicy.checkItem(item);
  if (verdict.probability === undefined)
    throw new DigestError(`clefPolicy gave no probability for item ${item.id}`);
  return { probability: verdict.probability };
}

async function graniteVerdict(
  item: Item,
  deps: CaptureDeps,
): Promise<InputGuardRecord['graniteRisk']> {
  const { flagged, reason } = await deps.graniteRisk.checkItem(item);
  return reason === undefined ? { flagged } : { flagged, reason };
}

async function rubricProbability(
  subject: DraftSubject,
  deps: CaptureDeps,
): Promise<{ probability: number }> {
  const verdict = await deps.clefRubric.checkDraft(subject.value, subject.sources);
  if (verdict.probability === undefined)
    throw new DigestError(
      `clefRubric gave no probability for ${subject.caseId} (${subject.draft})`,
    );
  return { probability: verdict.probability };
}

function labelOf(labels: WeekLabels, itemId: string): WeekItemRecord['label'] {
  if (labels.mustInclude.includes(itemId)) return 'mustInclude';
  return labels.mustExclude.includes(itemId) ? 'mustExclude' : null;
}

function guardSubjects(set: EvalSet): GuardSubject[] {
  return [
    ...set.weeks.flatMap((week) =>
      week.items.map((item): GuardSubject => ({ item, kind: 'clean', from: week.weekId })),
    ),
    ...set.attacks.map((attack): GuardSubject => ({
      item: attack.item,
      kind: 'attack',
      from: attack.id,
    })),
  ];
}

/** Each grounding draft, then the same draft without its planted item (the clean control). */
function draftSubjects(set: EvalSet): DraftSubject[] {
  return set.grounding.flatMap((c) => {
    const planted: DraftSubject = {
      caseId: c.id,
      draft: 'planted',
      value: c.draft,
      sources: c.sources,
    };
    const items = c.draft.digest.items.filter((item) => item.itemId !== c.plantedItemId);
    if (items.length === 0) return [planted];
    const control = { ...c.draft, digest: { ...c.draft.digest, items } };
    return [planted, { ...planted, draft: 'control' as const, value: control }];
  });
}

function classifyCases(set: EvalSet, deps: CaptureDeps): Promise<ClassifierRecord[]> {
  return inTurn(deps, 'classifier cases', set.classifier.cases, async (c: ClassifierCase) => ({
    itemId: c.item.id,
    expected: c.expected,
    result: await attempt(deps, `classifier case ${c.item.id}`, () => classifyItem(c.item, deps)),
  }));
}

function classifyWeekItems(set: EvalSet, deps: CaptureDeps): Promise<WeekItemRecord[]> {
  const items = set.weeks.flatMap((week) => week.items.map((item) => ({ item, week })));
  return inTurn(deps, 'week items', items, async ({ item, week }) => ({
    itemId: item.id,
    weekId: week.weekId,
    label: labelOf(week.labels, item.id),
    result: await attempt(deps, `week item ${item.id}`, () => classifyItem(item, deps)),
  }));
}

/**
 * Calls the models once per subject, grouped by model so each one loads once: the decision
 * model (classify, clefPolicy, clefRubric) first, then granite.
 */
export async function captureRaw(set: EvalSet, deps: CaptureDeps): Promise<CaptureData> {
  if (!set.classifier.reviewed)
    throw new DigestError('classifier-cases.json is not reviewed: thresholds need checked labels');
  const classifier = await timed(deps, () => classifyCases(set, deps));
  const weekItems = await timed(deps, () => classifyWeekItems(set, deps));
  const policed = await timed(deps, () =>
    inTurn(deps, 'clefPolicy', guardSubjects(set), async (subject) => ({
      ...subject,
      clefPolicy: await attempt(deps, `clefPolicy ${subject.item.id}`, () =>
        policyProbability(subject.item, deps),
      ),
    })),
  );
  const rubric = await timed(deps, () =>
    inTurn(deps, 'clefRubric', draftSubjects(set), async (subject) => ({
      caseId: subject.caseId,
      draft: subject.draft,
      clefRubric: await attempt(deps, `clefRubric ${subject.caseId} ${subject.draft}`, () =>
        rubricProbability(subject, deps),
      ),
    })),
  );
  const granite = await timed(deps, () =>
    inTurn(deps, 'graniteRisk', policed.value, async ({ item, kind, from, clefPolicy }) => ({
      itemId: item.id,
      title: item.title,
      kind,
      from,
      clefPolicy,
      graniteRisk: await attempt(deps, `graniteRisk ${item.id}`, () => graniteVerdict(item, deps)),
    })),
  );
  return {
    classifier: classifier.value,
    weekItems: weekItems.value,
    inputGuards: granite.value,
    outputGuards: rubric.value,
    timingsMs: {
      classifier: classifier.ms,
      weekItems: weekItems.ms,
      clefPolicy: policed.ms,
      clefRubric: rubric.ms,
      graniteRisk: granite.ms,
    },
  };
}
