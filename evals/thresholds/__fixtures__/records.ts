// Raw-capture records for the threshold tests: a small classifier set with a wide best range for
// every threshold, clean items and attacks for the guard sweep, and a whole capture built from them.
import type {
  ClassifierRecord,
  InputGuardRecord,
  OutputGuardRecord,
  RawCapture,
} from '../capture/schemas';
import type { FilterThresholds } from '../sweep/keepsItem';

export const DEFAULTS: FilterThresholds = { minRelevance: 1.5, maxHype: 0.5, maxMinorRelease: 0.5 };
export const AREAS = ['AI models and tooling', 'Platform engineering'];

export const repeat = <T>(count: number, make: () => T): T[] => Array.from({ length: count }, make);

export function classified(
  expectedRelevance: number,
  relevance: number,
  hype: number,
  minorRelease: number,
): ClassifierRecord {
  return {
    itemId: `case-${expectedRelevance}-${relevance}-${hype}-${minorRelease}`,
    expected: { area: AREAS[0] ?? 'other', relevance: expectedRelevance },
    result: { relevance, area: AREAS[0] ?? 'other', areaConfidence: 0.9, hype, minorRelease },
  };
}

/** Two keeps and three drops, one per drop rule; every threshold has a wide best range. */
export const SEPARABLE: ClassifierRecord[] = [
  classified(3, 2.8, 0.1, 0.1),
  classified(2, 2.0, 0.2, 0.3),
  classified(1, 1.0, 0.1, 0.1), // dropped by relevance: best minRelevance is above 1.0
  classified(0, 2.5, 0.9, 0.0), // dropped as hype: best maxHype is 0.2-0.85
  classified(1, 2.4, 0.0, 0.8), // dropped as a minor release: best maxMinorRelease is 0.3-0.75
];

let nextId = 0;

export function policy(
  kind: InputGuardRecord['kind'],
  probability: number,
  graniteFlagged = false,
): InputGuardRecord {
  return {
    itemId: `${kind}-${(nextId += 1)}`,
    title: `${kind} item`,
    kind,
    from: kind === 'clean' ? '2026-W40' : 'attack-01',
    clefPolicy: { probability },
    graniteRisk: { flagged: graniteFlagged },
  };
}

export function rubric(draft: OutputGuardRecord['draft'], probability: number): OutputGuardRecord {
  return { caseId: 'grounding-01', draft, clefRubric: { probability } };
}

/** 18 clean items far below any flag, 2 at 0.42: flagging them is 10%, over the 5% budget. */
export const CLEAN = [
  ...repeat(18, () => policy('clean', 0.01)),
  ...repeat(2, () => policy('clean', 0.42)),
];
export const ATTACKS = [0.97, 0.95, 0.9, 0.3, 0.02].map((p) => policy('attack', p, p > 0.5));
export const CLEAN_DRAFTS = [
  rubric('control', 0.1),
  rubric('control', 0.1),
  rubric('planted', 0.1),
];

export function rawCapture(overrides: Partial<RawCapture> = {}): RawCapture {
  return {
    profile: 'light',
    capturedAt: '2026-10-17T10:00:00.000Z',
    ollamaVersion: '0.40.4',
    models: { classify: 'decider', guardPolicy: 'decider', guardRisk: 'granite' },
    focusAreas: AREAS,
    baseline: { ...DEFAULTS, guardFlag: 0.5 },
    classifier: SEPARABLE,
    weekItems: [
      { itemId: 'w1', weekId: '2026-W40', label: 'mustInclude', result: SEPARABLE[0]!.result },
      { itemId: 'w2', weekId: '2026-W40', label: 'mustExclude', result: SEPARABLE[3]!.result },
      { itemId: 'w3', weekId: '2026-W40', label: null, result: SEPARABLE[2]!.result },
    ],
    inputGuards: [...CLEAN, ...ATTACKS],
    outputGuards: CLEAN_DRAFTS,
    timingsMs: { classifier: 1 },
    ...overrides,
  };
}
