// The capture run (W3-03): calls each model once per subject and returns the raw outputs.
// evals/tuneThresholds.ts runs it through cli/captureCommand.ts.
import type { Clock } from '../../../src/shared/clock';
import { DigestError } from '../../../src/shared/errors';
import type { ClassifierCase } from '../../schema';
import {
  classifyItem,
  graniteVerdict,
  policyProbability,
  rubricProbability,
  type ItemCallDeps,
} from './calls';
import { attempt, inTurn, timed, type Progress } from './runner';
import type { CaptureData, ClassifierRecord, WeekItemRecord } from './schemas';
import { draftSubjects, guardSubjects, heldOutFlag, labelOf, type EvalSet } from './subjects';

export interface CaptureDeps extends ItemCallDeps {
  clock: Clock;
  progress: Progress;
}

function classifyCases(set: EvalSet, deps: CaptureDeps): Promise<ClassifierRecord[]> {
  return inTurn(
    deps.progress,
    'classifier cases',
    set.classifier.cases,
    async (c: ClassifierCase) => ({
      itemId: c.item.id,
      expected: c.expected,
      result: await attempt(deps.progress, `classifier case ${c.item.id}`, () =>
        classifyItem(c.item, deps),
      ),
    }),
  );
}

function classifyWeekItems(set: EvalSet, deps: CaptureDeps): Promise<WeekItemRecord[]> {
  const items = set.weeks.flatMap((week) => week.items.map((item) => ({ item, week })));
  return inTurn(deps.progress, 'week items', items, async ({ item, week }) => ({
    itemId: item.id,
    weekId: week.weekId,
    label: labelOf(week.labels, item.id),
    result: await attempt(deps.progress, `week item ${item.id}`, () => classifyItem(item, deps)),
  }));
}

function policeInputs(set: EvalSet, deps: CaptureDeps) {
  return inTurn(deps.progress, 'clefPolicy', guardSubjects(set), async (subject) => ({
    ...subject,
    clefPolicy: await attempt(deps.progress, `clefPolicy ${subject.item.id}`, () =>
      policyProbability(subject.item, deps),
    ),
  }));
}

function checkDrafts(set: EvalSet, deps: CaptureDeps) {
  return inTurn(deps.progress, 'clefRubric', draftSubjects(set), async (subject) => ({
    caseId: subject.caseId,
    draft: subject.draft,
    ...heldOutFlag(subject),
    clefRubric: await attempt(deps.progress, `clefRubric ${subject.caseId} ${subject.draft}`, () =>
      rubricProbability(subject, deps),
    ),
  }));
}

/**
 * Calls the models once per subject, grouped by model so each one loads once: the decision
 * model (classify, clefPolicy, clefRubric) first, then granite.
 */
export async function captureRaw(set: EvalSet, deps: CaptureDeps): Promise<CaptureData> {
  if (!set.classifier.reviewed)
    throw new DigestError('classifier-cases.json is not reviewed: thresholds need checked labels');
  const classifier = await timed(deps.clock, () => classifyCases(set, deps));
  const weekItems = await timed(deps.clock, () => classifyWeekItems(set, deps));
  const policed = await timed(deps.clock, () => policeInputs(set, deps));
  const rubric = await timed(deps.clock, () => checkDrafts(set, deps));
  const granite = await timed(deps.clock, () =>
    inTurn(
      deps.progress,
      'graniteRisk',
      policed.value,
      async ({ item, kind, from, clefPolicy, heldOut }) => ({
        itemId: item.id,
        title: item.title,
        kind,
        from,
        ...heldOutFlag({ heldOut }),
        clefPolicy,
        graniteRisk: await attempt(deps.progress, `graniteRisk ${item.id}`, () =>
          graniteVerdict(item, deps),
        ),
      }),
    ),
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
